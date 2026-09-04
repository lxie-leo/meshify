"""STEP/STP CAD 读取（迁移自 maestro model_edit_step.py）。

gmsh 内置 OpenCASCADE 内核读取 B-rep → 二维曲面三角化 → 按颜色分组
（styled_item AP203/AP214）→ 每组独立 PBR 子网格。无颜色回退浅灰哑光。

meshify 改动：
- inspect_step：网格化后仅统计，不落盘（inspect 语义）
- mesh_step_groups：供 convert/inspect 复用的分组几何出口
"""

from __future__ import annotations

from typing import Dict, List, Optional, Tuple

import numpy as np

from .. import mesh_utils as mu
from ..errors import input_unreadable, param_conflict

DEFAULT_RGBA = (200, 200, 200, 255)

# 朝上轴 → (新坐标取旧坐标的下标, 对应符号)。全部 det=+1（纯旋转，不镜像）。
# STEP 文件本身不携带「部件哪个方向朝上」——CAD 惯例 Z-up 只是缺省假设；
# 部件在装配坐标系里躺着建模时（壁挂件横放等），需要 --up-axis 显式指定。
UP_AXIS_ROTATIONS = {
    "z": ([0, 2, 1], (1.0, 1.0, -1.0)),  # (x, z, -y) 绕 X 轴 -90°——CAD 惯例缺省
    "-z": ([0, 2, 1], (1.0, -1.0, 1.0)),  # (x, -z, y)
    "x": ([2, 0, 1], (1.0, 1.0, 1.0)),  # (z, x, y)
    "-x": ([1, 0, 2], (1.0, -1.0, 1.0)),  # (y, -x, z)
    "y": ([0, 1, 2], (1.0, 1.0, 1.0)),  # 源已是 Y-up，恒等
    "-y": ([0, 1, 2], (-1.0, -1.0, 1.0)),  # (−x, −y, z)
}


AXIS_NAMES = ("x", "y", "z")

# --up-axis auto：构成安装模式的最少孔数（同一面上 ≥3 个孔才视为底面证据）
_AUTO_MIN_HOLES = 3


def detect_up_axis(step_path: str) -> Dict[str, object]:
    """从 STEP 的 B-rep 特征推断部件朝上轴（--up-axis auto 后端）。

    保守策略——宁可拒绝让用户显式指定，不静默猜错：
    1. 收集轴对齐平面（法向/面积/位置）与圆柱面（轴向/半径/圆心）；
    2. 孔证据 = 小半径圆柱的共面簇（≥3 个、横向铺开），并用粗网格点包含测试
       区分真孔（轴线圆心在空腔 = 实体外）与凸台台阶（圆心在实体内，如端子
       螺柱的各段台阶）——后者轴向共面但不构成安装孔模式；
    3. 恰一个轴向的孔票数达标且明显领先（≥1.5×次名）→ 定轴；孔簇靠在包围盒
       哪端决定符号（孔所在面 = 底面朝下 → 其外法向的反方向为朝上轴），
       孔簇在中部时用平面面积辅证（底面一侧面积通常更大）。

    返回 {"resolved": "y"|"-z"|…|None, "evidence": str,
          "candidates": [{"axis", "note"}]}；resolved=None 表示低置信，
    调用方应拒绝并让用户显式指定。
    """
    try:
        import gmsh
    except ImportError as e:  # pragma: no cover - 环境缺失
        raise ImportError("解析 STEP 需要 gmsh（cd packages-py/kernel-py && uv sync）") from e

    gmsh.initialize(interruptible=False)
    try:
        gmsh.option.setNumber("General.Terminal", 0)
        gmsh.option.setNumber("General.Verbosity", 2)
        try:
            gmsh.merge(step_path)
            gmsh.model.occ.synchronize()
        except Exception as e:
            raise input_unreadable(f"STEP 解析失败（{step_path}）: {e}") from e

        x0, y0, z0, x1, y1, z1 = gmsh.model.getBoundingBox(-1, -1)
        lo = np.array([x0, y0, z0], dtype=np.float64)
        ext = np.array([x1 - x0, y1 - y0, z1 - z0], dtype=np.float64)
        if float(ext.min()) <= 0.0:
            return {"resolved": None, "evidence": "包围盒退化（零厚度），无法判定", "candidates": []}

        planes, cylinders = _collect_axis_faces(gmsh)
        total_area = sum(p["area"] for p in planes) or 1.0

        # 粗网格化一遍做点包含测试（判真孔/凸台）；失败则拒绝而非裸猜
        solid = _coarse_solid(gmsh, float(np.linalg.norm(ext)))
        if solid is None:
            return {
                "resolved": None,
                "evidence": "粗网格化失败，无法验证孔特征真伪",
                "candidates": _plane_candidates(planes, total_area),
            }

        hole_limit = max(0.08 * float(ext.min()), 1e-9)
        votes, clusters = _hole_votes(cylinders, solid, hole_limit, lo, ext)

        ranked = sorted(votes.items(), key=lambda kv: -kv[1])
        best_axis, best = ranked[0] if ranked else (None, 0)
        second = ranked[1][1] if len(ranked) > 1 else 0
        if best < _AUTO_MIN_HOLES or best < 1.5 * second:
            return {
                "resolved": None,
                "evidence": (
                    "孔证据不足或各轴向势均力敌（孔票数 "
                    + ", ".join(f"{AXIS_NAMES[i]}={votes[i]}" for i in range(3))
                    + "）——对称件/无安装孔/多向孔模式的部件无法可靠判定"
                ),
                "candidates": _plane_candidates(planes, total_area),
            }

        # 符号：极端侧孔簇（孔所在面 = 底面 → 外法向的反方向朝上）
        signs = {1 if cl["t_norm"] <= 0.25 else -1 for cl in clusters[best_axis] if cl["t_norm"] <= 0.25 or cl["t_norm"] >= 0.75}
        if len(signs) > 1:
            return {
                "resolved": None,
                "evidence": f"包围盒 ±{AXIS_NAMES[best_axis]} 两端都检出孔簇，无法区分哪端是底面",
                "candidates": _plane_candidates(planes, total_area),
            }
        if signs:
            sign = signs.pop()
        else:
            # 孔簇都在中部（如侧安装耳）：平面面积辅证——底面朝下的一侧通常更大
            area_plus = sum(p["area"] for p in planes if p["k"] == best_axis and p["sign"] > 0)
            area_minus = sum(p["area"] for p in planes if p["k"] == best_axis and p["sign"] < 0)
            sign = 1 if area_plus <= area_minus else -1

        resolved = AXIS_NAMES[best_axis] if sign > 0 else "-" + AXIS_NAMES[best_axis]
        side = "min" if sign > 0 else "max"
        ev_clusters = "、".join(f"{cl['count']}×r≈{cl['radius']:.1f}" for cl in clusters[best_axis])
        evidence = (
            f"⊥{AXIS_NAMES[best_axis]} 轴平面检出安装孔簇（{ev_clusters} mm，圆心均在实体外=真孔），"
            f"孔簇位于包围盒 {side} 侧 → 该面为底面朝下"
        )
        return {"resolved": resolved, "evidence": evidence, "candidates": []}
    finally:
        gmsh.clear()
        gmsh.finalize()


def _snap_axis(v) -> Optional[int]:
    """把方向（自动归一化）吸附到最近的主轴；偏离超过 ~10° 返回 None。"""
    a = np.asarray(v, dtype=np.float64)
    n = float(np.linalg.norm(a))
    if n <= 1e-12:
        return None
    a = np.abs(a) / n
    k = int(np.argmax(a))
    return k if a[k] >= 0.985 else None


def _circumcircle(p1, p2, p3):
    """三点外接圆（圆心, 半径）；近共线返回 (None, None)。"""
    a, b, c = np.asarray(p1, float), np.asarray(p2, float), np.asarray(p3, float)
    ab, ac = b - a, c - a
    n = np.cross(ab, ac)
    nn = float(n @ n)
    if nn <= 1e-12 * max(float(ab @ ab) * float(ac @ ac), 1e-30):
        return None, None
    center = a + (float(ac @ ac) * np.cross(n, ab) + float(ab @ ab) * np.cross(ac, n)) / (2.0 * nn)
    return center, float(np.linalg.norm(center - a))


def _collect_axis_faces(gmsh) -> Tuple[List[dict], List[dict]]:
    """收集轴对齐的平面（法向/面积/位置）与圆柱面（轴向/半径/圆心）。

    斜面/斜圆柱（偏离主轴 >10°）不参与判定。圆柱半径取同参数 v 三个点的外接圆。
    """
    planes: List[dict] = []
    cylinders: List[dict] = []
    for _dim, tag in gmsh.model.getEntities(2):
        typ = gmsh.model.getType(2, tag)
        try:
            (u0, v0), (u1, v1) = gmsh.model.getParametrizationBounds(2, tag)
        except Exception:
            continue
        um, vm = 0.5 * (u0 + u1), 0.5 * (v0 + v1)
        if typ == "Plane":
            n = np.asarray(gmsh.model.getNormal(tag, [um, vm]), dtype=np.float64)
            k = _snap_axis(n)
            if k is None:
                continue
            bb = gmsh.model.getBoundingBox(2, tag)
            e = sorted((bb[3] - bb[0], bb[4] - bb[1], bb[5] - bb[2]), reverse=True)
            p = np.asarray(gmsh.model.getValue(2, tag, [um, vm]), dtype=np.float64)
            planes.append({"k": k, "sign": 1 if n[k] > 0 else -1, "area": e[0] * e[1], "pos": float(p[k]), "dims": (e[0], e[1])})
        elif typ == "Cylinder":
            ua, ub = u0 + 0.2 * (u1 - u0), u0 + 0.8 * (u1 - u0)
            n1 = np.asarray(gmsh.model.getNormal(tag, [ua, vm]), dtype=np.float64)
            n2 = np.asarray(gmsh.model.getNormal(tag, [ub, vm]), dtype=np.float64)
            k = _snap_axis(np.cross(n1, n2))
            if k is None:
                continue
            p1 = np.asarray(gmsh.model.getValue(2, tag, [ua, vm]), dtype=np.float64)
            p2 = np.asarray(gmsh.model.getValue(2, tag, [um, vm]), dtype=np.float64)
            p3 = np.asarray(gmsh.model.getValue(2, tag, [ub, vm]), dtype=np.float64)
            center, r = _circumcircle(p1, p2, p3)
            if center is None:
                continue
            cylinders.append({"k": k, "radius": r, "t": float(p2[k]), "center": center})
    return planes, cylinders


def _coarse_solid(gmsh, diag: float):
    """整个模型粗网格化 → trimesh 实体（点包含测试用）。失败返回 None。"""
    try:
        import trimesh

        gmsh.model.mesh.setSizeCallback(lambda dim, tag, x, y, z, lc: diag / 12.0)
        gmsh.model.mesh.generate(2)
        node_tags, node_coords, _ = gmsh.model.mesh.getNodes()
        vertices = np.asarray(node_coords, dtype=np.float64).reshape(-1, 3)
        if len(vertices) == 0:
            return None
        tag_to_row = np.full(int(node_tags.max()) + 1, -1, dtype=np.int64)
        tag_to_row[np.asarray(node_tags, dtype=np.int64)] = np.arange(len(node_tags), dtype=np.int64)
        tris = []
        for _dim, tag in gmsh.model.getEntities(2):
            elem_types, _et, elem_node_tags = gmsh.model.mesh.getElements(2, tag)
            for etype, enodes in zip(elem_types, elem_node_tags):
                if etype != 2:  # MSH triangle
                    continue
                rows = tag_to_row[np.asarray(enodes, dtype=np.int64).reshape(-1, 3)]
                if (rows < 0).any():
                    continue
                tris.append(rows)
        if not tris:
            return None
        mesh = trimesh.Trimesh(vertices=vertices, faces=np.vstack(tris), process=True)
        mesh.merge_vertices()
        mesh.fix_normals()
        if mesh.volume < 0:
            mesh.invert()
        return mesh
    except Exception:
        return None


def _hole_votes(cylinders: List[dict], solid, hole_limit: float, lo: np.ndarray, ext: np.ndarray):
    """按轴向统计安装孔票数：小半径圆柱的共面簇（≥3 个、横向铺开、圆心在实体外）。"""
    votes = {0: 0, 1: 0, 2: 0}
    clusters = {0: [], 1: [], 2: []}
    tol_t = 0.04 * float(ext.min())
    for k in range(3):
        cand = sorted((c for c in cylinders if c["k"] == k and c["radius"] <= hole_limit), key=lambda c: c["t"])
        groups: List[dict] = []
        for c in cand:
            if groups and abs(c["t"] - groups[-1]["t_ref"]) <= tol_t:
                groups[-1]["members"].append(c)
            else:
                groups.append({"t_ref": c["t"], "members": [c]})
        for g in groups:
            members = g["members"]
            if len(members) < _AUTO_MIN_HOLES:
                continue
            # 横向铺开：聚类成一坨的圆柱（同一孔的分段）不算安装模式
            lateral = np.array([[m["center"][i] for i in range(3) if i != k] for m in members])
            scale = max(tol_t, 1e-9)
            uniq = {tuple(np.round(row / scale)) for row in lateral}
            if len(uniq) < _AUTO_MIN_HOLES:
                continue
            # 真孔 vs 凸台：孔的轴线圆心在空腔（实体外）；凸台台阶圆心在实体内
            try:
                inside = solid.contains([m["center"] for m in members])
            except Exception:
                inside = [True] * len(members)  # 无法验证 → 按凸台处理（保守不投票）
            holes = [m for m, ins in zip(members, inside) if not ins]
            if len(holes) < _AUTO_MIN_HOLES:
                continue
            t = float(np.mean([m["t"] for m in holes]))
            clusters[k].append(
                {
                    "count": len(holes),
                    "radius": float(np.median([m["radius"] for m in holes])),
                    "t_norm": float((t - lo[k]) / ext[k]) if ext[k] > 0 else 0.5,
                }
            )
            votes[k] += len(holes)
    return votes, clusters


def _plane_candidates(planes: List[dict], total_area: float) -> List[dict]:
    """拒绝时的候选参考：按法向汇总的平面面积 Top3。"""
    by_dir: Dict[Tuple[int, int], List[float]] = {}
    for p in planes:
        by_dir.setdefault((p["k"], p["sign"]), [0.0, 0])
        by_dir[(p["k"], p["sign"])][0] += p["area"]
        by_dir[(p["k"], p["sign"])][1] += 1
    ranked = sorted(by_dir.items(), key=lambda kv: -kv[1][0])[:3]
    out = []
    for (k, sign), (area, cnt) in ranked:
        name = ("+" if sign > 0 else "-") + AXIS_NAMES[k]
        out.append({"axis": name, "note": f"法向 {name} 的平面 {cnt} 张、面积占比 {area / total_area:.0%}（包围盒 {'max' if sign > 0 else 'min'} 侧）"})
    return out


def mesh_step_groups(step_path: str, resolution: int = 100) -> Tuple[List[Tuple[Optional[tuple], np.ndarray, np.ndarray]], Optional[List[List[float]]]]:
    """gmsh 读取 STEP 并三角化，返回 ([(rgba, vertices, faces)], bbox)。

    rgba 为 None 表示无颜色（默认材质组）。bbox 为 OCC 包围盒（网格化前）。
    """
    try:
        import gmsh
    except ImportError as e:  # pragma: no cover - 环境缺失
        raise ImportError("解析 STEP 需要 gmsh（cd packages-py/kernel-py && uv sync）") from e

    gmsh.initialize(interruptible=False)
    try:
        gmsh.option.setNumber("General.Terminal", 0)
        gmsh.option.setNumber("General.Verbosity", 2)
        try:
            gmsh.merge(step_path)
            gmsh.model.occ.synchronize()
        except Exception as e:
            # 读不进来 = 输入不可读（截断/伪 STEP），不是算法失败
            raise input_unreadable(f"STEP 解析失败（{step_path}）: {e}") from e

        xmin, ymin, zmin, xmax, ymax, zmax = gmsh.model.getBoundingBox(-1, -1)
        bbox = [[float(xmin), float(ymin), float(zmin)], [float(xmax), float(ymax), float(zmax)]]
        diag = float(((xmax - xmin) ** 2 + (ymax - ymin) ** 2 + (zmax - zmin) ** 2) ** 0.5)
        mesh_size = diag / resolution if diag > 0 else 0.1
        gmsh.model.mesh.setSizeCallback(lambda dim, tag, x, y, z, lc: mesh_size)
        gmsh.model.mesh.generate(2)

        node_tags, node_coords, _params = gmsh.model.mesh.getNodes()
        vertices = np.asarray(node_coords, dtype=np.float64).reshape(-1, 3)
        tag_to_row = np.full(int(node_tags.max()) + 1, -1, dtype=np.int64)
        tag_to_row[np.asarray(node_tags, dtype=np.int64)] = np.arange(len(node_tags), dtype=np.int64)

        buckets: Dict[Optional[tuple], list] = {}
        for _dim, tag in gmsh.model.getEntities(2):
            faces = _surface_triangles(gmsh, tag, tag_to_row)
            if faces is None:
                continue
            buckets.setdefault(_surface_color(gmsh, tag), []).append(faces)
    finally:
        gmsh.clear()
        gmsh.finalize()

    groups: List[Tuple[Optional[tuple], np.ndarray, np.ndarray]] = []
    for rgba, parts in buckets.items():
        faces = np.vstack(parts).astype(np.uint32)
        used = np.unique(faces)
        remap = np.zeros(len(vertices), dtype=np.uint32)
        remap[used] = np.arange(len(used), dtype=np.uint32)
        groups.append((rgba, vertices[used], remap[faces]))
    return groups, bbox


def groups_to_scene(groups, up_axis: str = "z") -> "object":
    """颜色分组 → trimesh.Scene（每组子网格 + 独立 PBR 材质）。

    STEP 坐标默认按 CAD 惯例视为 Z-up，glTF 规范要求 Y-up——旋转到 Y-up
    （det=+1 纯旋转保定向；几何形状不变）。up_axis 指定源文件中部件的实际
    朝上轴（x|y|z，可加 - 前缀），部件在装配坐标系里非 Z 朝上建模时用。
    朝向变化由 runner 集中披露（UP_AXIS_NORMALIZED）。
    """
    import trimesh

    scene = trimesh.Scene()
    for rgba, vertices, faces in groups:
        mesh = _build_trimesh(_orient_up(vertices, up_axis), faces, rgba)
        name = "part_default" if rgba is None else "color_{:02x}{:02x}{:02x}".format(*rgba[:3])
        scene.add_geometry(mesh, node_name=name)
    return scene


def _orient_up(vertices: np.ndarray, up_axis: str) -> np.ndarray:
    """把 up_axis 指定的源坐标朝上轴旋转为 glTF Y-up。"""
    try:
        indices, signs = UP_AXIS_ROTATIONS[up_axis]
    except KeyError:
        raise param_conflict(f"--up-axis 取值应为 x|y|z（可加 - 前缀表示反向），收到: {up_axis}") from None
    return vertices[:, list(indices)] * np.asarray(signs)


def step_to_glb(step_path: str, out_path: str, resolution: int = 100, up_axis: str = "z") -> Dict[str, int]:
    """STEP → GLB；返回 {vertices, faces}（manifest 输出统计用）。"""
    groups, _bbox = mesh_step_groups(step_path, resolution)
    if not groups:
        raise ValueError("STEP 文件未生成任何三角面，可能不包含实体几何或文件已损坏")
    scene = groups_to_scene(groups, up_axis)
    mu.save_mesh(scene, out_path, file_type="glb")
    total_v, total_f = scene_totals(scene)
    return {"vertices": total_v, "faces": total_f}


def inspect_step(step_path: str, resolution: int = 100) -> Dict[str, object]:
    """STEP 输入侧统计（inspect 语义：不落盘产物）。"""
    groups, bbox = mesh_step_groups(step_path, resolution)
    if not groups:
        raise ValueError("STEP 文件未生成任何三角面，可能不包含实体几何或文件已损坏")

    meshes = []
    total_v = 0
    total_f = 0
    materials = 0
    for i, (rgba, vertices, faces) in enumerate(groups):
        if rgba is not None:
            materials += 1
        name = "part_default" if rgba is None else "color_{:02x}{:02x}{:02x}".format(*rgba[:3])
        meshes.append(
            {
                "name": name,
                "vertices": int(len(vertices)),
                "faces": int(len(faces)),
                "material": name if rgba is not None else None,
                "has_uv": False,
                "has_normals": False,
            }
        )
        total_v += int(len(vertices))
        total_f += int(len(faces))
    if any(m["material"] is None for m in meshes):
        materials += 1  # 默认材质组

    import os

    return {
        "path": step_path,
        "format": "step",
        "bytes": os.path.getsize(step_path),
        "vertices": total_v,
        "faces": total_f,
        "meshes": meshes,
        "materials": materials,
        "textures": [],
        "bbox": bbox,
        "has_animation": False,
    }


def scene_totals(scene) -> Tuple[int, int]:
    import trimesh

    total_v = 0
    total_f = 0
    for g in getattr(scene, "geometry", {}).values():
        if isinstance(g, trimesh.Trimesh):
            total_v += int(len(g.vertices))
            total_f += int(len(g.faces))
    return total_v, total_f


def _surface_triangles(gmsh, tag: int, tag_to_row: np.ndarray) -> Optional[np.ndarray]:
    elem_types, _elem_tags, elem_node_tags = gmsh.model.mesh.getElements(2, tag)
    parts = []
    for etype, etags in zip(elem_types, elem_node_tags):
        if etype != 2:  # MSH triangle
            continue
        rows = tag_to_row[np.asarray(etags, dtype=np.int64).reshape(-1, 3)]
        if (rows < 0).any():
            continue
        parts.append(rows.astype(np.uint32))
    if not parts:
        return None
    return parts[0] if len(parts) == 1 else np.vstack(parts)


def _surface_color(gmsh, tag: int) -> Optional[tuple]:
    r, g, b, a = gmsh.model.getColor(2, tag)
    if a > 0:
        return (int(r), int(g), int(b), int(a))
    try:
        _downward, upward = gmsh.model.getAdjacencies(2, tag)
        for vol in upward:
            r, g, b, a = gmsh.model.getColor(3, int(vol))
            if a > 0:
                return (int(r), int(g), int(b), int(a))
    except Exception:
        pass
    return None


def _build_trimesh(vertices: np.ndarray, faces: np.ndarray, rgba: Optional[tuple]):
    import trimesh

    mesh = trimesh.Trimesh(vertices=vertices, faces=faces, process=True)
    if len(mesh.vertices) == 0:
        raise ValueError("STEP 转换后网格为空")

    mesh.update_faces(mesh.area_faces > 1e-12)
    mesh.remove_unreferenced_vertices()
    mesh.merge_vertices()
    mesh.fix_normals()
    _apply_pbr_material(mesh, rgba)
    return mesh


def _apply_pbr_material(mesh, rgba: Optional[tuple]) -> None:
    from trimesh.visual.material import PBRMaterial
    from trimesh.visual.texture import TextureVisuals

    r, g, b, a = rgba if rgba is not None else DEFAULT_RGBA
    mesh.visual = TextureVisuals(
        material=PBRMaterial(
            baseColorFactor=[int(r), int(g), int(b), int(a)],
            metallicFactor=0.0,
            roughnessFactor=0.8,
        )
    )


def write_step_fixture(out_path: str, size: float = 2.0) -> str:
    """用 OCC 生成真实 STEP 测试件（立方体 B-rep；fixtures/一致性测试用）。

    手写 ISO-10303 实体图极易造出 OpenCASCADE 拒收的伪文件；用 gmsh 自己的
    OCC 内核建体再导 STEP，保证读回路径与真实 CAD 文件完全一致。
    """
    try:
        import gmsh
    except ImportError as e:  # pragma: no cover
        raise ImportError("生成 STEP fixture 需要 gmsh") from e

    gmsh.initialize(interruptible=False)
    try:
        gmsh.option.setNumber("General.Terminal", 0)
        gmsh.model.add("meshify_fixture")
        gmsh.model.occ.addBox(-size / 2, -size / 2, -size / 2, size, size, size)
        gmsh.model.occ.synchronize()
        gmsh.write(out_path)
    finally:
        gmsh.clear()
        gmsh.finalize()
    return out_path


def write_holed_base_fixture(out_path: str) -> str:
    """带四角孔底板的躺姿部件（--up-axis auto 判定用 fixture）。

    底板 40×30×3 位于 z=0..3（底面外法向 -Z），其上立 20×15×18 箱体（总高 21），
    四角 r=1.5 通孔。建模成躺姿（底面朝 -Z）——auto 应判定朝上轴为 z 并旋转
    为 glTF Y-up（高度 21 立到 Y）。孔证据 + 包围盒极值缺一不可测。
    """
    try:
        import gmsh
    except ImportError as e:  # pragma: no cover
        raise ImportError("生成 STEP fixture 需要 gmsh") from e

    gmsh.initialize(interruptible=False)
    try:
        gmsh.option.setNumber("General.Terminal", 0)
        gmsh.model.add("meshify_fixture_holed")
        plate = gmsh.model.occ.addBox(-20.0, -15.0, 0.0, 40.0, 30.0, 3.0)
        gmsh.model.occ.addBox(-10.0, -7.5, 3.0, 20.0, 15.0, 18.0)
        holes = [gmsh.model.occ.addCylinder(x, y, -1.0, 0.0, 0.0, 5.0, 1.5) for x in (-16.0, 16.0) for y in (-11.0, 11.0)]
        gmsh.model.occ.cut([(3, plate)], [(3, h) for h in holes])
        gmsh.model.occ.synchronize()
        gmsh.write(out_path)
    finally:
        gmsh.clear()
        gmsh.finalize()
    return out_path
