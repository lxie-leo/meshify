"""QEM 简化（迁移自 maestro model_edit_simplify.py，pyfqmr）。

防闪烁/防残缺策略与警告披露：
- preserve_border/preserve_topology（maestro 实证参数）
- 贴图网格不按位置焊接（接缝双顶点防拉花）
- 几何重建后 UV 最近邻重映射保纹理；无法重映射降级 baseColor 标量并披露
- < min_faces 子网格跳过简化（SMALL_MESH_SKIPPED，坑 12）
- 产物材质 doubleSided（开口壳防背面剔除，坑 3）
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

import numpy as np

from .. import mesh_utils as mu
from ..manifest import warn

MIN_FACES_DEFAULT = 200


def simplify_file(
    input_path: str,
    output_path: str,
    *,
    ratio: float = 0.5,
    target_faces: Optional[int] = None,
    aggressiveness: int = 7,
    min_faces: int = MIN_FACES_DEFAULT,
    overwrite: bool = False,
) -> Dict[str, Any]:
    """逐子网格 QEM 简化 → GLB；返回 manifest 所需统计与警告。"""
    try:
        import pyfqmr
    except ImportError as e:  # pragma: no cover
        raise ImportError("Simplification requires pyfqmr (cd packages-py/kernel-py && uv sync)") from e

    import trimesh

    scene = mu.load_scene(input_path)
    geos = getattr(scene, "geometry", {})
    meshes = [
        (name, g)
        for name, g in geos.items()
        if isinstance(g, trimesh.Trimesh) and len(g.faces) > 0
    ]
    if not meshes:
        raise ValueError("Model contains no triangles; nothing to simplify")

    warnings: List[Dict[str, Any]] = []
    original_faces = sum(len(g.faces) for _, g in meshes)

    for name, geo in meshes:
        if len(geo.faces) < min_faces:
            warnings.append(
                warn(
                    "SMALL_MESH_SKIPPED",
                    f"{name}: {len(geo.faces)} < min-faces {min_faces}, skipped and kept as-is",
                    mesh=name,
                )
            )
            continue

        geo_uv = getattr(geo.visual, "uv", None)
        geo_mat = getattr(geo.visual, "material", None)
        has_texture = (
            geo_uv is not None
            and len(geo_uv) > 0
            and getattr(geo_mat, "baseColorTexture", None) is not None
        )

        faces_before = len(geo.faces)
        tgt = target_faces if target_faces is not None else max(1, int(faces_before * ratio))
        tgt = min(tgt, faces_before)  # ratio>1 或 target 超过原面数时封顶

        simplifier = pyfqmr.Simplify()
        simplifier.setMesh(
            np.asarray(geo.vertices, dtype=np.float32),
            np.asarray(geo.faces, dtype=np.uint32),
        )
        simplifier.simplify_mesh(
            target_count=tgt,
            aggressiveness=aggressiveness,
            preserve_border=True,
            verbose=False,
        )
        new_vertices, new_faces, _face_colors = simplifier.getMesh()
        new_faces = np.asarray(new_faces, dtype=np.uint32)

        new_mesh = _rebuild_mesh(np.asarray(new_vertices), new_faces, merge=not has_texture)
        new_visual = mu.material_visual_from(geo, target_vertices=new_mesh.vertices)
        if new_visual is None:
            warnings.append(
                warn(
                    "MATERIAL_DEGRADED_TO_BASE_COLOR",
                    f"{name}: source mesh has no reusable material (solid-color/vertex-color visual); output material falls back to default",
                    mesh=name,
                )
            )
        else:
            if getattr(new_visual, "uv", None) is None and has_texture:
                warnings.append(
                    warn(
                        "MATERIAL_DEGRADED_TO_BASE_COLOR",
                        f"{name}: UVs could not be remapped onto the simplified vertices; material degraded to baseColor scalar only (textures stripped)",
                        mesh=name,
                    )
                )
            else:
                warnings.append(
                    warn(
                        "UV_REMAP_APPROXIMATED",
                        f"{name}: UVs of collapsed vertices remapped by nearest-face barycentric interpolation (approximate; heavily deformed regions may stretch)",
                        mesh=name,
                    )
                )
            new_mesh.visual = new_visual
            mat = getattr(new_mesh.visual, "material", None)
            if mat is not None and hasattr(type(mat), "doubleSided"):
                mat.doubleSided = True
                warnings.append(warn("DOUBLE_SIDED_FORCED", f"{name}: output material forced doubleSided (open shells vs. backface culling)", mesh=name))

        if has_texture:
            new_uv = getattr(new_mesh.visual, "uv", None)
            if new_uv is not None:
                new_mesh.visual.uv = mu.split_uv_seam(new_mesh, new_uv)

        geos[name] = new_mesh

    mu.save_mesh(scene, output_path, file_type="glb")
    total_v, total_f = _scene_totals(scene)
    return {
        "output_path": output_path,
        "vertices": total_v,
        "faces": total_f,
        "faces_before": original_faces,
        "warnings": warnings,
        "metrics": {
            "face_reduction": 1 - (total_f / original_faces if original_faces else 0),
            "ratio_actual": (total_f / original_faces) if original_faces else 0,
        },
    }


def _rebuild_mesh(vertices: np.ndarray, faces: np.ndarray, merge: bool = True):
    import trimesh

    mesh = trimesh.Trimesh(vertices=vertices, faces=faces, process=merge)
    mesh.update_faces(mesh.area_faces > 1e-12)
    mesh.remove_unreferenced_vertices()
    if merge:
        mesh.merge_vertices()
    mesh.fix_normals()
    return mesh


def _scene_totals(scene):
    import trimesh

    total_v = 0
    total_f = 0
    for g in getattr(scene, "geometry", {}).values():
        if isinstance(g, trimesh.Trimesh):
            total_v += int(len(g.vertices))
            total_f += int(len(g.faces))
    return total_v, total_f
