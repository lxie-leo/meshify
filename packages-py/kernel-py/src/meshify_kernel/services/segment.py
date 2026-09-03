"""三模式分割（迁移自 maestro model_edit_segment.py）。

- connected：跨子网格焊接后的连通域拆件（实体级）
- plane：平面切割（earcut 封口保水密，坑 5；碎片面保留，坑 6）
- semantic：法线+位置 KMeans 聚类 + 同标签连通切分 + 碎块合并

meshify 改动：
- 平面定义支持 axis+position（[-1,1] 线性映射包围盒，maestro 滑块语义）
  与 origin/normal（原生坐标）双入口（CLI 已做互斥校验）
- 部件写 output_dir/part_%03d.glb；未预声明的部件文件同样遵守 overwrite 约定
- 警告按契约码写入 manifest
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import numpy as np

from .. import mesh_utils as mu
from ..manifest import warn


def segment_file(
    input_path: str,
    output_dir: str,
    *,
    mode: str,
    clusters: int = 8,
    axis: Optional[str] = None,
    position: float = 0.0,
    origin: Optional[List[float]] = None,
    normal: Optional[List[float]] = None,
    cap: bool = True,
    min_faces: int = 1,
    overwrite: bool = False,
) -> Dict[str, Any]:
    if mode == "semantic":
        parts, warnings = _segment_semantic(input_path, clusters)
    elif mode == "plane":
        parts, warnings = _segment_plane(input_path, axis, position, origin, normal, cap)
    elif mode == "connected":
        parts, warnings = _segment_connected(input_path, min_faces)
    else:
        raise ValueError(f"不支持的分割模式: {mode}")

    if not parts:
        raise ValueError("分割未产生任何部件")

    written: List[Dict[str, Any]] = []
    total_v = 0
    total_f = 0
    for i, part in enumerate(parts):
        out_path = str(Path(output_dir) / f"part_{i:03d}.glb")
        _guard_overwrite(out_path, overwrite, input_path)
        mu.save_mesh(part, out_path, file_type="glb")
        v, f = _counts(part)
        written.append({"path": out_path, "role": "part", "index": i, "vertices": v, "faces": f})
        total_v += v
        total_f += f

    return {
        "parts": written,
        "vertices": total_v,
        "faces": total_f,
        "warnings": warnings,
        "tier_note": f"{mode}: {len(parts)} 部件" + ("（截面 earcut 封口）" if mode == "plane" and cap else ""),
    }


def _guard_overwrite(out_path: str, overwrite: bool, input_path: str) -> None:
    """CLI 只预声明 part_000；后续部件由本侧强制同一覆盖约定。"""
    import os

    if os.path.abspath(out_path) == os.path.abspath(input_path):
        raise ValueError(f"输出路径与输入相同: {out_path}")
    if os.path.exists(out_path) and not overwrite:
        raise FileExistsError(f"输出已存在: {out_path}（默认不覆盖；确认覆盖请加 --overwrite）")


# ------------------------------------------------------------------
# 实体级加载（跨子网格焊接）
# ------------------------------------------------------------------


def _load_solids(file_path: str):
    import trimesh
    from scipy.sparse import coo_matrix
    from scipy.sparse.csgraph import connected_components
    from trimesh.visual.color import ColorVisuals

    scene = trimesh.load(file_path, force="scene", process=False)
    geos = [
        g
        for g in getattr(scene, "geometry", {}).values()
        if isinstance(g, trimesh.Trimesh) and len(g.faces) > 0
    ]
    if not geos:
        return [], [], np.zeros(0, dtype=np.int64)

    offs = np.cumsum([0] + [len(g.vertices) for g in geos])
    combined = trimesh.Trimesh(
        vertices=np.vstack([g.vertices for g in geos]),
        faces=np.vstack([np.asarray(g.faces) + offs[i] for i, g in enumerate(geos)]),
        process=False,
    )
    combined.visual = ColorVisuals()
    combined.merge_vertices()
    face_src = np.concatenate([np.full(len(g.faces), i, dtype=np.int64) for i, g in enumerate(geos)])

    n_faces = len(combined.faces)
    adjacency = np.asarray(combined.face_adjacency)
    if len(adjacency):
        graph = coo_matrix(
            (np.ones(len(adjacency), dtype=np.int8), (adjacency[:, 0], adjacency[:, 1])),
            shape=(n_faces, n_faces),
        )
        _n, comp_of = connected_components(graph, directed=False)
        comp_of = np.asarray(comp_of)
    else:
        comp_of = np.arange(n_faces, dtype=np.int64)

    solids = []
    for c in np.unique(comp_of):
        ids = np.flatnonzero(comp_of == c)
        solid = trimesh.Trimesh(vertices=combined.vertices.copy(), faces=combined.faces[ids], process=True)
        solids.append((solid, ids))
    return solids, geos, face_src


def _majority_source(face_ids, global_ids, face_src, src_meshes):
    counts = np.bincount(face_src[global_ids[face_ids]], minlength=len(src_meshes))
    return src_meshes[int(counts.argmax())]


def _build_part(solid, face_ids, global_ids, face_src, src_meshes, warnings):
    """从实体面索引构建部件；材质降级时写披露警告（meshify 增）。"""
    import trimesh

    part_src = face_src[global_ids[face_ids]]
    groups = np.unique(part_src)
    if len(groups) == 1:
        mesh = trimesh.Trimesh(vertices=solid.vertices.copy(), faces=solid.faces[face_ids], process=True)
        _attach_material(src_meshes[int(groups[0])], mesh, warnings)
        return mesh

    scene = trimesh.Scene()
    for g in groups:
        mesh = trimesh.Trimesh(
            vertices=solid.vertices.copy(),
            faces=solid.faces[face_ids[part_src == g]],
            process=True,
        )
        if len(mesh.faces) == 0:
            continue
        _attach_material(src_meshes[int(g)], mesh, warnings)
        scene.add_geometry(mesh, node_name=f"src{int(g)}", geom_name=f"src{int(g)}")
    return scene


def _attach_material(src_mesh, dst_mesh, warnings) -> None:
    if getattr(dst_mesh.visual, "material", None) is not None:
        pass
    visual = mu.material_visual_from(src_mesh, target_vertices=dst_mesh.vertices)
    if visual is not None:
        dst_mesh.visual = visual
        uv = getattr(visual, "uv", None)
        if uv is not None:
            warnings.append(
                warn("UV_REMAP_APPROXIMATED", f"{getattr(dst_mesh, 'metadata', {}).get('name', 'part')}: 分割重组顶点 UV 最近邻重映射（近似）")
            )
            dst_mesh.visual.uv = mu.split_uv_seam(dst_mesh, uv)

    mat = getattr(dst_mesh.visual, "material", None)
    if mat is not None:
        if hasattr(type(mat), "doubleSided"):
            mat.doubleSided = True
    else:
        from trimesh.visual.material import PBRMaterial
        from trimesh.visual.texture import TextureVisuals

        dst_mesh.visual = TextureVisuals(material=PBRMaterial(baseColorFactor=[255, 255, 255, 255], doubleSided=True))
    warnings.append(warn("DOUBLE_SIDED_FORCED", "分割产物材质强制 doubleSided（开口壳防背面剔除）"))


# ------------------------------------------------------------------
# semantic
# ------------------------------------------------------------------


def _segment_semantic(file_path: str, n_clusters: int) -> Tuple[List[Any], List[Dict[str, Any]]]:
    import trimesh
    from sklearn.cluster import KMeans

    warnings: List[Dict[str, Any]] = []
    parts: List[Any] = []
    solids, src_meshes, face_src = _load_solids(file_path)
    for solid, global_ids in solids:
        face_normals = np.asarray(solid.face_normals)
        if len(face_normals) == 0:
            continue

        centers = np.asarray(solid.triangles_center, dtype=float)
        bounds = np.asarray(solid.bounds, dtype=float)
        extents = np.maximum(bounds[1] - bounds[0], 1e-12)
        features = np.hstack([face_normals, (centers - bounds[0]) / extents])

        if len(face_normals) > n_clusters * 100:
            idx = np.random.RandomState(42).choice(len(face_normals), n_clusters * 100, replace=False)
            sample = features[idx]
        else:
            sample = features

        km = KMeans(n_clusters=min(n_clusters, len(face_normals)), random_state=42, n_init=10)
        km.fit(sample)
        labels = np.asarray(km.predict(features))

        min_face_count = max(10, int(len(face_normals) * 0.02))
        for face_ids in _connected_parts(solid, labels, min_face_count):
            part = _build_part(solid, face_ids, global_ids, face_src, src_meshes, warnings)
            if isinstance(part, trimesh.Scene):
                if len(part.geometry) > 0:
                    parts.append(part)
            elif len(part.faces) > 0:
                parts.append(part)
    return parts, warnings


# ------------------------------------------------------------------
# plane
# ------------------------------------------------------------------


def _segment_plane(
    file_path: str,
    axis: Optional[str],
    position: float,
    origin: Optional[List[float]],
    normal: Optional[List[float]],
    cap: bool,
) -> Tuple[List[Any], List[Dict[str, Any]]]:
    import trimesh

    warnings: List[Dict[str, Any]] = []

    solids, src_meshes, face_src = _load_solids(file_path)
    if not solids:
        raise ValueError("模型不包含三角面")

    # axis+position → 世界系平面（与 kernel-ts resolvePlane 同一映射）
    if origin is None or normal is None:
        if not axis:
            raise ValueError("平面定义缺失：需要 axis+position 或 origin+normal")
        all_bounds = np.array([s[0].bounds for s in solids])
        lo = all_bounds[:, 0].min(axis=0)
        hi = all_bounds[:, 1].max(axis=0)
        ai = {"x": 0, "y": 1, "z": 2}[axis]
        coord = float(lo[ai] + ((position + 1) / 2) * (hi[ai] - lo[ai]))
        origin = [float((lo[0] + hi[0]) / 2), float((lo[1] + hi[1]) / 2), float((lo[2] + hi[2]) / 2)]
        origin[ai] = coord
        normal = [0.0, 0.0, 0.0]
        normal[ai] = 1.0

    nvec = np.asarray(normal, dtype=float)
    nvec = nvec / (np.linalg.norm(nvec) + 1e-9)

    parts: List[Any] = []
    for solid, global_ids in solids:
        org = np.asarray(solid.centroid if origin is None else origin, dtype=float)
        cap_kw = {"cap": cap, "engine": "earcut"} if cap else {"cap": False}
        upper = trimesh.intersections.slice_mesh_plane(solid, nvec, org, **cap_kw)
        lower = trimesh.intersections.slice_mesh_plane(solid, -nvec, org, **cap_kw)
        src = _majority_source(np.arange(len(solid.faces)), global_ids, face_src, src_meshes)
        for side in (upper, lower):
            if side is not None and len(side.faces) > 0:
                if cap:
                    # 坑 6：earcut 封口可能产生零面积碎片三角形——保留（删了会开洞）
                    warnings.append(warn("FRAGMENT_FACES_KEPT", "截面封口的零面积碎片三角形原样保留（渲染不可见，删除会开洞）"))
                _attach_material(src, side, warnings)
                parts.append(side)

    if len(parts) < 2:
        raise ValueError("切割平面未将模型分成两部分，请调整平面位置")
    return parts, warnings


# ------------------------------------------------------------------
# connected
# ------------------------------------------------------------------


def _segment_connected(file_path: str, min_faces: int) -> Tuple[List[Any], List[Dict[str, Any]]]:
    warnings: List[Dict[str, Any]] = []
    parts: List[Any] = []
    all_solids = []
    dropped = 0
    solids, src_meshes, face_src = _load_solids(file_path)
    for solid, global_ids in solids:
        all_solids.append((solid, global_ids))
        if len(solid.faces) >= min_faces:
            _attach_material(
                _majority_source(np.arange(len(solid.faces)), global_ids, face_src, src_meshes),
                solid,
                warnings,
            )
            parts.append(solid)
        else:
            dropped += 1

    if not parts and all_solids:
        solid, global_ids = max(all_solids, key=lambda s: len(s[0].faces))
        _attach_material(
            _majority_source(np.arange(len(solid.faces)), global_ids, face_src, src_meshes),
            solid,
            warnings,
        )
        parts = [solid]
    if dropped:
        warnings.append(
            warn("SMALL_PARTS_DROPPED", f"连通域分割：{dropped} 个面数 < {min_faces} 的碎片部件被丢弃")
        )
    return parts, warnings


# ------------------------------------------------------------------
# semantic 连通切分 + 碎块合并（maestro 原样迁移）
# ------------------------------------------------------------------


def _connected_parts(mesh, labels: np.ndarray, min_face_count: int) -> List[np.ndarray]:
    from collections import defaultdict

    from scipy.sparse import coo_matrix
    from scipy.sparse.csgraph import connected_components

    n_faces = len(labels)
    adjacency = np.asarray(mesh.face_adjacency)
    if len(adjacency) == 0:
        comp_of = np.arange(n_faces, dtype=np.int64)
    else:
        same = labels[adjacency[:, 0]] == labels[adjacency[:, 1]]
        f1, f2 = adjacency[same, 0], adjacency[same, 1]
        graph = coo_matrix((np.ones(len(f1), dtype=np.int8), (f1, f2)), shape=(n_faces, n_faces))
        _n, comp_of = connected_components(graph, directed=False)
        comp_of = np.asarray(comp_of, dtype=np.int64)

    centers = np.asarray(mesh.triangles_center, dtype=float)

    while True:
        sizes = np.bincount(comp_of)
        n_comp = len(sizes)
        alive_ids = [int(x) for x in np.flatnonzero(sizes > 0)]
        small = [c for c in alive_ids if sizes[c] < min_face_count]
        if not small:
            break

        r1, r2 = comp_of[adjacency[:, 0]], comp_of[adjacency[:, 1]]
        cross = r1 != r2
        lo = np.minimum(r1[cross], r2[cross])
        hi = np.maximum(r1[cross], r2[cross])
        keys, counts = np.unique(lo * n_faces + hi, return_counts=True)
        shared: Dict[int, Dict[int, int]] = defaultdict(dict)
        for key, cnt in zip(keys, counts):
            a, b = divmod(int(key), n_faces)
            shared[a][b] = int(cnt)
            shared[b][a] = int(cnt)

        cent = np.zeros((n_comp, 3), dtype=float)
        np.add.at(cent, comp_of, centers)
        alive = sizes > 0
        cent[alive] /= sizes[alive][:, None]

        merges: Dict[int, int] = {}
        fallback: List[int] = []
        for c in sorted(small, key=lambda s: sizes[s]):
            target = -1
            best_score = (-1, -1)
            for nbr, cnt in shared.get(c, {}).items():
                root = nbr
                while root in merges:
                    root = merges[root]
                if root == c:
                    continue
                score = (int(cnt), int(sizes[nbr]))
                if score > best_score:
                    best_score, target = score, root
            if target >= 0:
                merges[c] = target
            else:
                fallback.append(c)

        if fallback:
            stable = [x for x in alive_ids if x not in merges and sizes[x] >= min_face_count]
            cand = stable or [x for x in alive_ids if x not in merges]
            if cand:
                from scipy.spatial import KDTree

                cand_arr = np.asarray(cand, dtype=np.int64)
                tree = KDTree(cent[cand_arr])
                k = min(2, len(cand_arr))
                _dists, idx = tree.query(cent[np.asarray(fallback)], k=k)
                idx = np.atleast_2d(np.asarray(idx))
                for row, src in enumerate(fallback):
                    for j in idx[row]:
                        tgt = int(cand_arr[j])
                        if tgt != src:
                            merges[src] = tgt
                            break

        if not merges:
            break

        mapping = np.arange(n_comp, dtype=np.int64)
        for child, tgt in merges.items():
            mapping[child] = tgt
        while True:
            stepped = mapping[mapping]
            if np.array_equal(stepped, mapping):
                break
            mapping = stepped
        comp_of = mapping[comp_of]

    uniq = np.unique(comp_of)
    return [np.flatnonzero(comp_of == c) for c in uniq]


def _counts(part) -> Tuple[int, int]:
    import trimesh

    if isinstance(part, trimesh.Scene):
        geos = [g for g in part.geometry.values() if isinstance(g, trimesh.Trimesh)]
        return (sum(len(g.vertices) for g in geos), sum(len(g.faces) for g in geos))
    return int(len(part.vertices)), int(len(part.faces))
