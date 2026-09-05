"""一体化优化（Tier1 路径）。

Tier1 无 meshopt/draco WASM 编码器（那是 Tier0 专属）：几何压缩参数
在此显式降级并披露，绝不假装压缩过。
- 简化（可选 ratio）→ pyfqmr
- 贴图压缩/降采样：Pillow（webp 不可用于 glTF 核心 → 转 PNG/JPEG 并披露）
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from ..manifest import warn
from . import simplify as simplify_svc


def optimize_file(
    input_path: str,
    output_path: str,
    *,
    ratio: Optional[float] = None,
    compression: str = "meshopt",
    texture_format: str = "none",
    max_texture_size: Optional[int] = None,
    min_faces: int = 200,
    overwrite: bool = False,
) -> Dict[str, Any]:
    warnings: List[Dict[str, Any]] = []

    if compression != "none":
        warnings.append(
            warn(
                "TIER_DOWNGRADED",
                f"Geometry compression codec={compression} requires Tier0 (meshoptimizer/draco WASM); "
                "the Tier1 path outputs an uncompressed GLB. Drop --tier py to let routing pick Tier0 when compression is needed.",
            )
        )

    if texture_format != "none":
        warnings.append(
            warn(
                "TEXTURE_DOWNSCALED",
                f"Texture handling texture-format={texture_format}: glTF core only embeds PNG/JPEG natively; "
                "Tier1 normalizes to PNG" + (f", longest edge capped at {max_texture_size}" if max_texture_size else ""),
            )
        )

    result: Dict[str, Any]
    if ratio is not None:
        result = simplify_svc.simplify_file(
            input_path,
            output_path,
            ratio=ratio,
            min_faces=min_faces,
            overwrite=overwrite,
        )
    else:
        # 无简化诉求：重导出（清理 + 贴图降采样）
        result = _reexport(input_path, output_path, texture_format, max_texture_size, overwrite)

    result["warnings"] = warnings + result.get("warnings", [])
    result["tier_note"] = "Tier1 optimize: geometry compression / texture WebP are Tier0 capabilities; this path is an uncompressed baseline"
    return result


def _reexport(
    input_path: str,
    output_path: str,
    texture_format: str,
    max_texture_size: Optional[int],
    overwrite: bool,
) -> Dict[str, Any]:
    from .. import mesh_utils as mu
    from . import step as step_svc

    scene = mu.load_scene(input_path)

    if texture_format != "none":
        _downscale_textures(scene, max_texture_size)

    mu.save_mesh(scene, output_path, file_type="glb")
    total_v, total_f = step_svc.scene_totals(scene)
    return {
        "output_path": output_path,
        "vertices": total_v,
        "faces": total_f,
        "faces_before": total_f,
        "warnings": [],
        "metrics": {},
    }


def _downscale_textures(scene, max_texture_size: Optional[int]) -> None:
    """贴图规范化：非 PNG/JPEG → PNG；超尺寸 → 降采样（坑 11 披露）。"""
    import io

    from PIL import Image

    for geo in getattr(scene, "geometry", {}).values():
        mat = getattr(getattr(geo, "visual", None), "material", None)
        if mat is None:
            continue
        img = getattr(mat, "baseColorTexture", None)
        if img is None:
            continue
        converted = False
        if img.mode not in {"RGB", "RGBA"}:
            img = img.convert("RGBA")
            converted = True
        if max_texture_size is not None and max(img.size) > max_texture_size:
            scale = max_texture_size / max(img.size)
            img = img.resize((max(1, round(img.width * scale)), max(1, round(img.height * scale))), Image.LANCZOS)
            converted = True
        if converted:
            buf = io.BytesIO()
            img.save(buf, format="PNG")
            buf.seek(0)
            mat.baseColorTexture = Image.open(buf)
