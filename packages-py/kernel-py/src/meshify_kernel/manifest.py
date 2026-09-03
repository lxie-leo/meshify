"""meshify.report/v1 manifest 组装（TS 侧 zod 复验；字段名严格对齐 core/src/schema.ts）。

输入侧信息按格式分路：
- glb/gltf：pygltflib 解析原始 JSON（属性/材质/贴图/动画以文件声明为准，
  不依赖 trimesh 的推断性补全）
- obj/stl/ply：trimesh 读取（--tier py 显式指定时的路径）
- step/stp：gmsh OpenCASCADE 网格化后统计（inspect 语义：无产物落盘）
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Dict, List, Optional

from . import REPORT_SCHEMA, TIER, TOOL_NAME, __version__

STEP_EXTS = {".step", ".stp"}
GLTF_EXTS = {".glb", ".gltf"}


# ------------------------------------------------------------------
# 节点世界矩阵（bbox 需要世界系语义，与 Tier0 烘焙一致）
# ------------------------------------------------------------------


def _mat4_mul(a, b):
    """4×4 行主序矩阵乘（a ∘ b）。"""
    return [
        [sum(a[i][k] * b[k][j] for k in range(4)) for j in range(4)]
        for i in range(4)
    ]


def _mat4_identity():
    return [[1.0 if i == j else 0.0 for j in range(4)] for i in range(4)]


def _mat4_apply(m, p):
    """齐次仿射变换点（不做透视除法；glTF 节点矩阵恒仿射）。"""
    return [
        m[i][0] * p[0] + m[i][1] * p[1] + m[i][2] * p[2] + m[i][3]
        for i in range(3)
    ]


def _node_local_matrix(node):
    """节点局部矩阵：matrix（列主序）优先，否则 TRS 合成（T·R·S）。"""
    if node.matrix is not None and len(node.matrix) == 16:
        col = [float(v) for v in node.matrix]
        return [
            [col[0], col[4], col[8], col[12]],
            [col[1], col[5], col[9], col[13]],
            [col[2], col[6], col[10], col[14]],
            [col[3], col[7], col[11], col[15]],
        ]
    t = [float(v) for v in (node.translation or [0.0, 0.0, 0.0])]
    s = [float(v) for v in (node.scale or [1.0, 1.0, 1.0])]
    q = [float(v) for v in (node.rotation or [0.0, 0.0, 0.0, 1.0])]  # x,y,z,w
    x, y, z, w = q
    # 四元数 → 3×3 旋转（右手系标准式）
    r = [
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ]
    m = _mat4_identity()
    for i in range(3):
        for j in range(3):
            m[i][j] = r[i][j] * s[j]
        m[i][3] = t[i]
    return m


def _node_world_matrices(gltf) -> Dict[int, list]:
    """场景根 DFS 计算各节点世界矩阵（glTF 节点森林；复用节点取首次路径）。"""
    nodes = list(gltf.nodes or [])
    children = [list(node.children or []) for node in nodes]
    world: Dict[int, list] = {}

    def visit(idx: int, parent):
        if not 0 <= idx < len(nodes):
            return
        local = _node_local_matrix(nodes[idx])
        w = _mat4_mul(parent, local)
        if idx not in world:
            world[idx] = w
            for child in children[idx]:
                visit(child, w)

    scene = gltf.scenes[gltf.scene] if gltf.scene is not None and gltf.scenes else None
    if scene is not None:
        for root in scene.nodes or []:
            visit(root, _mat4_identity())
    # 孤儿节点（不在场景树中）按自身局部矩阵兜底，统计不缺漏
    for idx in range(len(nodes)):
        if idx not in world:
            visit(idx, _mat4_identity())
    return world

# ------------------------------------------------------------------
# 输入侧
# ------------------------------------------------------------------


def build_input_info(path: str, params: Dict[str, Any]) -> Dict[str, Any]:
    ext = Path(path).suffix.lower()
    if not os.path.isfile(path):
        raise FileNotFoundError(path)
    if ext in GLTF_EXTS:
        return _gltf_input_info(path)
    if ext in STEP_EXTS:
        from .services import step as step_svc

        return step_svc.inspect_step(path, resolution=int(params.get("resolution", 100)))
    return _mesh_input_info(path)


def _gltf_input_info(path: str) -> Dict[str, Any]:
    """glb/gltf 结构化统计（pygltflib；属性存在性以文件声明为准）。"""
    from pygltflib import GLTF2

    gltf = GLTF2().load(path)

    meshes: List[Dict[str, Any]] = []
    total_verts = 0
    total_faces = 0
    for mi, mesh in enumerate(gltf.meshes or []):
        name = mesh.name or f"mesh_{mi}"
        m_verts = 0
        m_faces = 0
        has_uv = False
        has_normals = False
        material = None
        for prim in mesh.primitives:
            attrs = prim.attributes or {}
            pos_idx = getattr(attrs, "POSITION", None)
            pos_count = (
                gltf.accessors[pos_idx].count or 0
                if pos_idx is not None and 0 <= pos_idx < len(gltf.accessors)
                else 0
            )
            m_verts += pos_count
            if prim.indices is not None and 0 <= prim.indices < len(gltf.accessors):
                m_faces += (gltf.accessors[prim.indices].count or 0) // 3
            else:
                m_faces += pos_count // 3  # 非索引基元：三角形带/扇此处不细分，meshify 管线不产出
            if getattr(attrs, "TEXCOORD_0", None) is not None:
                has_uv = True
            if getattr(attrs, "NORMAL", None) is not None:
                has_normals = True
            if prim.material is not None and 0 <= prim.material < len(gltf.materials or []):
                material = gltf.materials[prim.material].name or f"material_{prim.material}"
        meshes.append(
            {
                "name": name,
                "vertices": m_verts,
                "faces": m_faces,
                "material": material,
                "has_uv": has_uv,
                "has_normals": has_normals,
            }
        )
        total_verts += m_verts
        total_faces += m_faces

    textures: List[Dict[str, Any]] = []
    images = gltf.images or []
    buffers = gltf.buffers or []
    for img in images:
        uri = img.uri or "(embedded)"
        mime = img.mimeType
        nbytes = 0
        if img.bufferView is not None and 0 <= img.bufferView < len(gltf.bufferViews or []):
            nbytes = gltf.bufferViews[img.bufferView].byteLength or 0
        elif uri and not uri.startswith("data:"):
            try:
                nbytes = os.path.getsize(os.path.join(os.path.dirname(path), uri))
            except OSError:
                nbytes = 0
        textures.append({"uri": uri, "mime": mime, "bytes": int(nbytes), "resolution": None})
    _ = buffers  # 仅表明已读取；GLB buffer 内嵌无需落盘检查

    bbox: Optional[List[List[float]]] = None
    world_of = _node_world_matrices(gltf)
    for ni, node in enumerate(gltf.nodes or []):
        if node.mesh is None:
            continue
        mesh = gltf.meshes[node.mesh]
        world = world_of.get(ni)
        for prim in mesh.primitives:
            pos_idx = getattr(prim.attributes, "POSITION", None)
            if pos_idx is None or pos_idx >= len(gltf.accessors):
                continue
            acc = gltf.accessors[pos_idx]
            if acc.min and acc.max:
                lo = [float(v) for v in acc.min]
                hi = [float(v) for v in acc.max]
                if world is not None:
                    # 世界系 AABB：8 角点过节点世界矩阵（与 Tier0 烘焙语义一致）
                    corners = [
                        [x, y, z]
                        for x in (lo[0], hi[0])
                        for y in (lo[1], hi[1])
                        for z in (lo[2], hi[2])
                    ]
                    pts = [_mat4_apply(world, c) for c in corners]
                    lo = [min(p[i] for p in pts) for i in range(3)]
                    hi = [max(p[i] for p in pts) for i in range(3)]
                if bbox is None:
                    bbox = [lo, hi]
                else:
                    bbox[0] = [min(a, b) for a, b in zip(bbox[0], lo)]
                    bbox[1] = [max(a, b) for a, b in zip(bbox[1], hi)]

    return {
        "path": path,
        "format": Path(path).suffix.lower().lstrip("."),
        "bytes": os.path.getsize(path),
        "vertices": total_verts,
        "faces": total_faces,
        "meshes": meshes,
        "materials": len(gltf.materials or []),
        "textures": textures,
        "bbox": bbox,
        # 动画/蒙皮输入由 CLI 路由层硬规则拦截改走 Tier0；走到这里必为 false
        "has_animation": bool(gltf.animations) or bool(gltf.skins),
    }


def _mesh_input_info(path: str) -> Dict[str, Any]:
    """obj/stl/ply 统计（trimesh；--tier py 显式路径）。

    走 mesh_utils.load_scene：空 OBJ → 空场景（统一空场景语义），
    解析失败 → input_unreadable（exit 2，不落内部错误）。
    """
    import numpy as np
    import trimesh

    from . import mesh_utils as mu

    scene = mu.load_scene(path)
    geos = {
        name: g
        for name, g in getattr(scene, "geometry", {}).items()
        if isinstance(g, trimesh.Trimesh) and len(g.faces) > 0
    }
    meshes: List[Dict[str, Any]] = []
    total_verts = 0
    total_faces = 0
    all_verts: List[Any] = []
    for name, g in geos.items():
        uv = getattr(g.visual, "uv", None)
        # OBJ 的 vn / STL 的面法线在 trimesh 中会被归一化重算，无法区分来源；
        # 按容器语义保守上报 False（Tier0 路径读原始属性更精确）
        meshes.append(
            {
                "name": name,
                "vertices": int(len(g.vertices)),
                "faces": int(len(g.faces)),
                "material": _material_name(g),
                "has_uv": uv is not None and len(uv) > 0,
                "has_normals": False,
            }
        )
        total_verts += len(g.vertices)
        total_faces += len(g.faces)
        all_verts.append(np.asarray(g.vertices))

    bbox: Optional[List[List[float]]] = None
    if all_verts:
        stacked = np.vstack(all_verts)
        bbox = [
            [float(v) for v in stacked.min(axis=0)],
            [float(v) for v in stacked.max(axis=0)],
        ]
    return {
        "path": path,
        "format": Path(path).suffix.lower().lstrip("."),
        "bytes": os.path.getsize(path),
        "vertices": int(total_verts),
        "faces": int(total_faces),
        "meshes": meshes,
        "materials": len({m["material"] for m in meshes if m["material"]}),
        "textures": [],
        "bbox": bbox,
        "has_animation": False,
    }


def _material_name(mesh) -> Optional[str]:
    mat = getattr(mesh.visual, "material", None)
    if mat is None:
        return None
    return getattr(mat, "name", None) or type(mat).__name__


# ------------------------------------------------------------------
# manifest 组装
# ------------------------------------------------------------------


def build_report(
    *,
    command: str,
    input_info: Dict[str, Any],
    output: Optional[Dict[str, Any]],
    params: Dict[str, Any],
    metrics: Dict[str, Any],
    warnings: List[Dict[str, Any]],
    errors: List[str],
    exit_code: int,
    duration_ms: int,
) -> Dict[str, Any]:
    """组装完整 manifest；字段集与 core/src/schema.ts 的 zod 定义一致。"""
    return {
        "schema": REPORT_SCHEMA,
        "tool": {"name": TOOL_NAME, "version": __version__, "tier": TIER},
        "command": command,
        "input": input_info,
        "output": output,
        "params": params,
        "metrics": {"duration_ms": int(duration_ms), **metrics},
        "warnings": warnings,
        "errors": errors,
        "exit_code": int(exit_code),
    }


def warn(code: str, message: str, mesh: Optional[str] = None) -> Dict[str, Any]:
    """契约警告项（code 必须在 WARNING_CODES 枚举内，否则 TS 侧 zod 拒收）。"""
    item: Dict[str, Any] = {"code": code, "message": message}
    if mesh is not None:
        item["mesh"] = mesh
    return item
