"""LOD 链生成（Tier1：逐级 QEM 简化，几何级联——每级基于上一级继续简化）。

输出 output_dir/part_%03d.glb（0 = 原始层级，1..N-1 逐级 ratio 递减）。
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Dict, List

from ..errors import param_conflict
from ..manifest import warn
from . import simplify as simplify_svc


def lod_file(
    input_path: str,
    output_dir: str,
    *,
    levels: int,
    ratio: float,
    aggressiveness: int = 7,
    min_faces: int = 200,
    overwrite: bool = False,
) -> Dict[str, Any]:
    if levels < 2 or levels > 16:
        raise param_conflict(f"--levels must be in 2..16, got: {levels}")

    import os
    import shutil

    from .. import mesh_utils as mu
    from . import step as step_svc  # 复用 scene_totals

    stage_input = input_path
    level_files: List[Dict[str, Any]] = []
    total_v = 0
    total_f = 0
    warnings: List[Dict[str, Any]] = []

    # 层级 0：原始模型直接写一份（LOD 链起点，meshopt LOD 语义）。
    # 先验加载：空场景/坏输入在写盘前失败，不留半截产物。
    scene = _load_any(input_path)
    # 多场景 GLB：孤儿几何不挂载的话，part_000 是字节直拷还保得住，但层级 1+
    # 重新按场景图加载就会丢掉它们——统一先挂载并写警告，各层级规则一致
    attached = mu.attach_orphan_geometries(scene)
    if attached:
        warnings.append(
            warn(
                "ORPHAN_GEOMETRY_ATTACHED",
                f"Input contains {len(attached)} orphan geometries not mounted in the scene graph "
                f"(non-default scenes of a multi-scene GLB); attached explicitly to prevent loss along the LOD chain: "
                f"{', '.join(attached[:8])}{'…' if len(attached) > 8 else ''}",
            )
        )
    v, f = step_svc.scene_totals(scene)
    if f == 0:
        raise ValueError("Input contains no triangles; cannot build a LOD chain")

    out0 = str(Path(output_dir) / "part_000.glb")
    if os.path.exists(out0) and not overwrite:
        raise param_conflict(f"Output already exists: {out0} (not overwritten by default; pass --overwrite to replace)")

    if Path(input_path).suffix.lower() == ".glb" and not attached:
        # 无孤儿的 GLB 字节直拷（lod_0 语义 = 原样）；其余格式不能直拷
        # （.step/.obj/.stl/.ply 改名成 .glb 是坏 GLB），经 trimesh 落成合法 GLB
        shutil.copyfile(input_path, out0)
    else:
        mu.save_mesh(scene, out0, file_type="glb")
    level_files.append({"level": 0, "path": out0, "vertices": v, "faces": f, "ratio": 1.0})
    total_v += v
    total_f += f

    stage_input = out0
    for level in range(1, levels):
        out_path = str(Path(output_dir) / f"part_{level:03d}.glb")
        if os.path.exists(out_path) and not overwrite:
            raise param_conflict(f"Output already exists: {out_path} (not overwritten by default; pass --overwrite to replace)")
        result = simplify_svc.simplify_file(
            stage_input,
            out_path,
            ratio=ratio,
            aggressiveness=aggressiveness,
            min_faces=min_faces,
            overwrite=overwrite,
        )
        level_files.append(
            {
                "level": level,
                "path": out_path,
                "vertices": result["vertices"],
                "faces": result["faces"],
                "ratio": ratio,
            }
        )
        total_v += result["vertices"]
        total_f += result["faces"]
        if level == 1:
            # extend 而非赋值：层级 1 的简化警告不能覆盖已收集的孤儿挂载警告
            warnings = warnings + result["warnings"]
        stage_input = out_path

    # 级别数变少重跑后，目录里可能残留上次的更高级别 part 文件；
    # manifest 只描述本次产物，残留不披露会误导 glob 收产物的下游
    stale = sorted(
        name
        for name in os.listdir(output_dir)
        if _part_level(name) is not None and _part_level(name) >= levels
    )
    if stale:
        warnings.append(
            warn(
                "STALE_LOD_LEVELS",
                f"Output directory contains {len(stale)} LOD file(s) beyond the current chain (level ≥ {levels}): "
                f"{', '.join(stale)}. They are leftovers from a previous run with more levels; "
                f"this manifest describes only the {levels} file(s) written now. Delete them manually if unwanted.",
            )
        )

    return {
        "parts": [
            {"path": lf["path"], "role": "lod", "index": i, "vertices": lf["vertices"], "faces": lf["faces"]}
            for i, lf in enumerate(level_files)
        ],
        "lod_levels": [
            {
                "level": lf["level"],
                "path": lf["path"],
                "faces": lf["faces"],
                "vertices": lf["vertices"],
                "bytes": os.path.getsize(lf["path"]),
                "ratio": lf["ratio"],
            }
            for lf in level_files
        ],
        "vertices": total_v,
        "faces": total_f,
        "warnings": warnings,
        "tier_note": f"lod: {levels} levels (cascading ratio={ratio})",
    }


def _load_any(path: str):
    from .. import mesh_utils as mu

    return mu.load_scene(path)


def _part_level(name: str):
    """part_%03d.glb → 级别号；不匹配命名约定返回 None。"""
    m = re.fullmatch(r"part_(\d{3})\.glb", name)
    return int(m.group(1)) if m else None
