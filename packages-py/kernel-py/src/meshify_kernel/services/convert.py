"""格式转换（Tier1 路径：STEP 读入 + trimesh 导出）。

STEP → 任意目标：OCC 网格化 → 颜色分组场景 → 目标格式导出。
glb/gltf/obj/stl/ply 互转：trimesh 重导出（gltf 内嵌 data URI 自包含）。
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Dict

from .. import mesh_utils as mu
from ..errors import param_conflict
from ..manifest import warn
from . import step as step_svc

SUPPORTED = {"glb", "gltf", "obj", "stl", "ply"}


def convert_file(
    input_path: str,
    output_path: str,
    *,
    to: str,
    resolution: int = 100,
    overwrite: bool = False,
) -> Dict[str, Any]:
    to = to.lower().lstrip(".")
    if to not in SUPPORTED:
        raise param_conflict(f"目标格式不支持: {to}（支持 {', '.join(sorted(SUPPORTED))}）")

    import os

    if os.path.abspath(output_path) == os.path.abspath(input_path):
        raise param_conflict(f"输出路径与输入相同: {output_path}")
    if os.path.exists(output_path) and not overwrite:
        raise param_conflict(f"输出已存在: {output_path}（默认不覆盖；确认覆盖请加 --overwrite）")

    ext = Path(input_path).suffix.lower()
    warnings = []
    if ext in {".step", ".stp"}:
        groups, _bbox = step_svc.mesh_step_groups(input_path, resolution)
        if not groups:
            raise ValueError("STEP 文件未生成任何三角面，可能不包含实体几何或文件已损坏")
        scene = step_svc.groups_to_scene(groups)
        _export(scene, output_path, to)
        total_v, total_f = step_svc.scene_totals(scene)
    else:
        scene = mu.load_scene(input_path)
        # 多 scene GLB：未被默认 scene 挂载的几何不 attach 会被导出静默丢弃
        # （scene_totals 却按 geometry 全量统计 → 面数虚报 + 子网格丢失）
        attached = mu.attach_orphan_geometries(scene)
        if attached:
            warnings.append(
                warn(
                    "ORPHAN_GEOMETRY_ATTACHED",
                    f"输入含 {len(attached)} 个未挂载进场景图的孤儿几何（多 scene GLB 的非默认 scene），"
                    f"已显式挂载防止导出丢失: {', '.join(attached[:8])}{'…' if len(attached) > 8 else ''}",
                )
            )
        _export(scene, output_path, to)
        total_v, total_f = step_svc.scene_totals(scene)

    if total_f == 0:
        warnings.append(
            warn("EMPTY_SCENE_OUTPUT", "输入为空场景（0 面），产物是同格式的合法空文件")
        )

    return {
        "output_path": output_path,
        "vertices": total_v,
        "faces": total_f,
        "warnings": warnings,
        "tier_note": f"trimesh 导出 {to}" + ("；STEP 经 OCC 网格化" if ext in {".step", ".stp"} else ""),
    }


def _export(scene, output_path: str, to: str) -> None:
    # 空场景：trimesh 拒绝导出空 Scene（"Can't export empty scenes!"），但
    # convert 是结构操作——空输入应产出同格式的合法空文件（与 Tier0 同口径）
    import trimesh

    has_faces = any(len(getattr(g, "faces", [])) > 0 for g in getattr(scene, "geometry", {}).values())
    target = scene if has_faces else trimesh.Trimesh(process=False)
    if to == "gltf":
        mu.export_gltf_embedded(target, output_path)
    else:
        mu.save_mesh(target, output_path, file_type=to)
