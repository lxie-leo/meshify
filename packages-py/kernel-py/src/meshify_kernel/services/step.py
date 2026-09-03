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

DEFAULT_RGBA = (200, 200, 200, 255)


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
        gmsh.merge(step_path)
        gmsh.model.occ.synchronize()

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


def groups_to_scene(groups) -> "object":
    """颜色分组 → trimesh.Scene（每组子网格 + 独立 PBR 材质）。"""
    import trimesh

    scene = trimesh.Scene()
    for rgba, vertices, faces in groups:
        mesh = _build_trimesh(vertices, faces, rgba)
        name = "part_default" if rgba is None else "color_{:02x}{:02x}{:02x}".format(*rgba[:3])
        scene.add_geometry(mesh, node_name=name)
    return scene


def step_to_glb(step_path: str, out_path: str, resolution: int = 100) -> Dict[str, int]:
    """STEP → GLB；返回 {vertices, faces}（manifest 输出统计用）。"""
    groups, _bbox = mesh_step_groups(step_path, resolution)
    if not groups:
        raise ValueError("STEP 文件未生成任何三角面，可能不包含实体几何或文件已损坏")
    scene = groups_to_scene(groups)
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
