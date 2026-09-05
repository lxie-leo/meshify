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
    up_axis: str = "z",
    overwrite: bool = False,
) -> Dict[str, Any]:
    to = to.lower().lstrip(".")
    if to not in SUPPORTED:
        raise param_conflict(f"Unsupported target format: {to} (supported: {', '.join(sorted(SUPPORTED))})")

    import os

    if os.path.abspath(output_path) == os.path.abspath(input_path):
        raise param_conflict(f"Output path equals input: {output_path}")
    if os.path.exists(output_path) and not overwrite:
        raise param_conflict(f"Output already exists: {output_path} (not overwritten by default; pass --overwrite to replace)")

    ext = Path(input_path).suffix.lower()
    warnings = []
    auto_info = None
    if ext in {".step", ".stp"}:
        if up_axis == "auto":
            det = step_svc.detect_up_axis(input_path)
            if det["resolved"] is None:
                cands = "; ".join(f"{c['axis']}: {c['note']}" for c in det["candidates"]) or "no usable plane features"
                raise param_conflict(
                    f"--up-axis auto could not resolve the up axis: {det['evidence']}. Candidates: {cands}. "
                    "Pass --up-axis x|y|z explicitly (a leading - flips direction)"
                )
            up_axis = str(det["resolved"])
            auto_info = det
        groups, _bbox = step_svc.mesh_step_groups(input_path, resolution)
        if not groups:
            raise ValueError("STEP file produced no triangles; the file may contain no solid geometry or be corrupt")
        scene = step_svc.groups_to_scene(groups, up_axis)
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
                    f"Input contains {len(attached)} orphan geometries not mounted in the scene graph "
                    f"(non-default scenes of a multi-scene GLB); attached explicitly to prevent loss on export: "
                    f"{', '.join(attached[:8])}{'…' if len(attached) > 8 else ''}",
                )
            )
        _export(scene, output_path, to)
        total_v, total_f = step_svc.scene_totals(scene)

    if total_f == 0:
        warnings.append(
            warn("EMPTY_SCENE_OUTPUT", "Input is an empty scene (0 faces); the output is a valid empty file of the same format")
        )

    return {
        "output_path": output_path,
        "vertices": total_v,
        "faces": total_f,
        "warnings": warnings,
        "tier_note": f"trimesh export to {to}" + ("; STEP meshed via OCC" if ext in {".step", ".stp"} else ""),
        **({"up_axis_resolved": auto_info["resolved"], "up_axis_evidence": auto_info["evidence"]} if auto_info else {}),
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
