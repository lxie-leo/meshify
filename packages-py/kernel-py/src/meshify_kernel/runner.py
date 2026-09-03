"""payload 分发 runner。

- 读取 payload.json → 命令分发 → manifest 组装 → stdout 输出 → 语义化退出
- 失败也输出完整 manifest（errors + exit_code），进程按码退出——
  TS 侧桥解析 stdout 后会原样传播退出码，绝不出假 0
"""

from __future__ import annotations

import json
import os
import sys
import time
import traceback
from pathlib import Path
from typing import Any, Dict, Optional

from . import __version__
from .errors import (
    EXIT_ALGORITHM_FAILED,
    EXIT_INPUT_UNREADABLE,
    EXIT_INTERNAL,
    EXIT_OK,
    EXIT_PARAM_CONFLICT,
    EXIT_RESOURCE_LIMIT,
    KernelError,
)
from .manifest import build_input_info, build_report

_MAX_INPUT_BYTES = 512 * 1024 * 1024


def run_payload(payload: Dict[str, Any]) -> Dict[str, Any]:
    """执行 payload，返回完整 manifest dict（不打印不退出；供测试复用）。"""
    started = time.perf_counter()

    command = str(payload.get("command", ""))
    params = dict(payload.get("params") or {})
    input_path = str(payload.get("input", ""))
    output_path = payload.get("output")
    output_dir = payload.get("output_dir")
    overwrite = bool(payload.get("overwrite"))

    errors: list[str] = []
    warnings: list[Dict[str, Any]] = []
    exit_code = EXIT_OK

    # ---- 输入前置检查 ----
    input_info: Optional[Dict[str, Any]] = None
    output: Optional[Dict[str, Any]] = None
    metrics: Dict[str, Any] = {}
    if not input_path or not os.path.isfile(input_path):
        errors.append(f"输入不可读: {input_path}")
        exit_code = EXIT_INPUT_UNREADABLE
    elif os.path.getsize(input_path) > _MAX_INPUT_BYTES and not payload.get("force"):
        errors.append(
            f"输入超过 Tier1 资源上限（{os.path.getsize(input_path) / 1024 / 1024:.0f} MB > 512 MB）；--force 一次性处理"
        )
        exit_code = EXIT_RESOURCE_LIMIT

    if exit_code == EXIT_OK:
        try:
            input_info = build_input_info(input_path, params)

            # 几何命令空输入统一拦截（inspect/convert 是结构操作，不拦）：
            # 与 Tier0 侧行为对齐——0 面 = exit 6，且在任何产物写盘前失败
            if command in {"simplify", "segment", "texture", "lod", "optimize"} and input_info.get("faces", 0) == 0:
                raise KernelError(EXIT_ALGORITHM_FAILED, "输入不含任何三角面，几何命令无可处理几何")

            # 输出目录兜底创建（CLI 会预建；直接 payload 调用时同样成立）
            if output_path:
                os.makedirs(os.path.dirname(os.path.abspath(output_path)) or ".", exist_ok=True)
            if output_dir:
                os.makedirs(output_dir, exist_ok=True)


            handlers = {
                "inspect": _cmd_inspect,
                "simplify": _cmd_simplify,
                "segment": _cmd_segment,
                "texture": _cmd_texture,
                "convert": _cmd_convert,
                "lod": _cmd_lod,
                "optimize": _cmd_optimize,
            }
            handler = handlers.get(command)
            if handler is None:
                raise KernelError(EXIT_PARAM_CONFLICT, f"未知命令: {command}")
            if command == "inspect":
                result = handler(input_path, params, None, None, overwrite)
            else:
                result = handler(input_path, params, output_path, output_dir, overwrite)

            warnings.extend(result.pop("warnings", []))
            output = result.pop("output", None)
            metrics.update(result)

            # 统一派生削减指标（单文件命令）
            if output and input_info:
                if output["faces"] or input_info["faces"]:
                    metrics.setdefault("face_reduction", 1 - (output["faces"] / input_info["faces"] if input_info["faces"] else 0))
                if input_info["bytes"]:
                    metrics.setdefault("byte_reduction", 1 - (output["bytes"] / input_info["bytes"]))
        except KernelError as e:
            errors.append(str(e))
            exit_code = e.code
        except FileExistsError as e:
            errors.append(str(e))
            exit_code = EXIT_PARAM_CONFLICT
        except (ValueError, NotImplementedError) as e:
            errors.append(f"几何算法失败: {e}")
            exit_code = EXIT_ALGORITHM_FAILED
        except ImportError as e:
            errors.append(f"Tier1 依赖缺失: {e}")
            exit_code = EXIT_INTERNAL
        except MemoryError:
            errors.append("内存超限（Tier1）")
            exit_code = EXIT_RESOURCE_LIMIT
        except Exception as e:  # noqa: BLE001 - 未知异常按内部错误披露完整栈
            errors.append(f"内部错误: {e}\n{traceback.format_exc()}")
            exit_code = EXIT_INTERNAL

    if input_info is None:
        # 输入不可读时的兜底 manifest（结构完整，统计归零）
        input_info = {
            "path": input_path,
            "format": Path(input_path).suffix.lower().lstrip("."),
            "bytes": 0,
            "vertices": 0,
            "faces": 0,
            "meshes": [],
            "materials": 0,
            "textures": [],
            "bbox": None,
            "has_animation": False,
        }

    duration_ms = int((time.perf_counter() - started) * 1000)
    return build_report(
        command=command or "(unknown)",
        input_info=input_info,
        output=output,
        params=params,
        metrics=metrics,
        warnings=warnings,
        errors=errors,
        exit_code=exit_code,
        duration_ms=duration_ms,
    )


# ------------------------------------------------------------------
# 命令实现
# ------------------------------------------------------------------


def _file_info(path: str, role: str) -> Dict[str, Any]:
    return {"path": path, "bytes": os.path.getsize(path), "role": role}


def _single_output(out_path: str, fmt: str, vertices: int, faces: int, files: list) -> Dict[str, Any]:
    return {
        "path": out_path,
        "format": fmt,
        "bytes": sum(f["bytes"] for f in files if f.get("role") == "asset") or os.path.getsize(out_path),
        "vertices": vertices,
        "faces": faces,
        "files": files,
    }


def _cmd_inspect(input_path, params, output_path, output_dir, overwrite):
    # 输入侧统计已由 run_payload → build_input_info 完成；inspect 无产物
    return {"tier_note": "Tier1 inspect：结构统计（trimesh/gmsh 路线）"}


def _cmd_simplify(input_path, params, output_path, output_dir, overwrite):
    if not output_path:
        raise KernelError(EXIT_PARAM_CONFLICT, "simplify 需要 payload.output")
    from .services import simplify as svc

    target_faces = params.get("target_faces")
    result = svc.simplify_file(
        input_path,
        output_path,
        ratio=float(params.get("ratio", 0.5)),
        target_faces=int(target_faces) if target_faces is not None else None,
        aggressiveness=int(params.get("aggressiveness", 7)),
        min_faces=int(params.get("min_faces", svc.MIN_FACES_DEFAULT)),
        overwrite=overwrite,
    )
    files = [_file_info(output_path, "asset")]
    output = _single_output(output_path, "glb", result["vertices"], result["faces"], files)
    metrics = dict(result.get("metrics", {}))
    if result.get("tier_note"):
        metrics["tier_note"] = result["tier_note"]
    return {"output": output, "warnings": result.get("warnings", []), **metrics}


def _cmd_segment(input_path, params, output_path, output_dir, overwrite):
    if not output_dir:
        raise KernelError(EXIT_PARAM_CONFLICT, "segment 需要 payload.output_dir")
    from .services import segment as svc

    result = svc.segment_file(
        input_path,
        output_dir,
        mode=str(params.get("mode", "")),
        clusters=int(params.get("clusters", 8)),
        axis=params.get("axis"),
        position=float(params.get("position", 0.0)),
        origin=params.get("origin"),
        normal=params.get("normal"),
        cap=bool(params.get("cap", True)),
        min_faces=int(params.get("min_faces", 1)),
        overwrite=overwrite,
    )
    files = [_file_info(p["path"], "part") for p in result["parts"]]
    parts_metrics = [
        {"index": p["index"], "path": p["path"], "vertices": p["vertices"], "faces": p["faces"]}
        for p in result["parts"]
    ]
    total_bytes = sum(f["bytes"] for f in files)
    output = {
        "path": result["parts"][0]["path"],
        "format": "glb",
        "bytes": total_bytes,
        "vertices": result["vertices"],
        "faces": result["faces"],
        "files": files,
    }
    return {
        "output": output,
        "warnings": result.get("warnings", []),
        "parts": parts_metrics,
        "tier_note": result.get("tier_note"),
    }


def _cmd_texture(input_path, params, output_path, output_dir, overwrite):
    if not output_path:
        raise KernelError(EXIT_PARAM_CONFLICT, "texture 需要 payload.output")
    from .services import texture as svc

    # --image 可选（与 Tier0 契约一致：无贴图时仅重生成 UV）
    image = params.get("image")
    result = svc.texture_file(
        input_path,
        output_path,
        map_mode=str(params.get("map", "box")),
        image_path=str(image) if image is not None else None,
        metallic=params.get("metallic"),
        roughness=params.get("roughness"),
        overwrite=overwrite,
    )
    files = [_file_info(output_path, "asset")]
    output = _single_output(output_path, "glb", result["vertices"], result["faces"], files)
    return {
        "output": output,
        "warnings": result.get("warnings", []),
        "tier_note": "Tier1 texture：合并网格重投影（无 --image 时仅重生成 UV，材质统一为默认 PBR）",
    }


def _cmd_convert(input_path, params, output_path, output_dir, overwrite):
    if not output_path:
        raise KernelError(EXIT_PARAM_CONFLICT, "convert 需要 payload.output")
    from .services import convert as svc

    to = str(params.get("to", "glb"))
    result = svc.convert_file(input_path, output_path, to=to, overwrite=overwrite)
    files = [_file_info(output_path, "asset")]
    output = _single_output(output_path, to, result["vertices"], result["faces"], files)
    return {"output": output, "warnings": result.get("warnings", []), "tier_note": result.get("tier_note")}


def _cmd_lod(input_path, params, output_path, output_dir, overwrite):
    if not output_dir:
        raise KernelError(EXIT_PARAM_CONFLICT, "lod 需要 payload.output_dir")
    from .services import lod as svc

    result = svc.lod_file(
        input_path,
        output_dir,
        levels=int(params.get("levels", 3)),
        ratio=float(params.get("ratio", 0.5)),
        min_faces=int(params.get("min_faces", 200)),
        overwrite=overwrite,
    )
    files = [_file_info(p["path"], "lod") for p in result["parts"]]
    output = {
        "path": result["lod_levels"][0]["path"],
        "format": "glb",
        "bytes": sum(f["bytes"] for f in files),
        "vertices": result["vertices"],
        "faces": result["faces"],
        "files": files,
    }
    return {
        "output": output,
        "warnings": result.get("warnings", []),
        "lod_levels": result["lod_levels"],
        "tier_note": result.get("tier_note"),
    }


def _cmd_optimize(input_path, params, output_path, output_dir, overwrite):
    if not output_path:
        raise KernelError(EXIT_PARAM_CONFLICT, "optimize 需要 payload.output")
    from .services import optimize as svc

    ratio = params.get("ratio")
    texture_size = params.get("max_texture_size")
    result = svc.optimize_file(
        input_path,
        output_path,
        ratio=float(ratio) if ratio is not None else None,
        compression=str(params.get("compression", "meshopt")),
        texture_format=str(params.get("texture_format", "none")),
        max_texture_size=int(texture_size) if texture_size is not None else None,
        min_faces=int(params.get("min_faces", 200)),
        overwrite=overwrite,
    )
    files = [_file_info(output_path, "asset")]
    output = _single_output(output_path, "glb", result["vertices"], result["faces"], files)
    metrics = dict(result.get("metrics", {}))
    if result.get("tier_note"):
        metrics["tier_note"] = result["tier_note"]
    return {"output": output, "warnings": result.get("warnings", []), **metrics}


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        sys.stderr.write("用法: python -m meshify_kernel <payload.json>\n")
        return EXIT_PARAM_CONFLICT
    try:
        with open(argv[1], "r", encoding="utf-8") as f:
            payload = json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        sys.stderr.write(f"payload 不可读: {e}\n")
        return EXIT_INPUT_UNREADABLE

    report = run_payload(payload)
    # 唯一 stdout 输出：完整 manifest（TS 桥从 stdout 提取 JSON）
    sys.stdout.write(json.dumps(report, ensure_ascii=False, default=float) + "\n")
    sys.stdout.flush()
    return int(report["exit_code"])
