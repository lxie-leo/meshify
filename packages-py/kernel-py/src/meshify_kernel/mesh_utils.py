"""几何工具层：网格的读取与保存，以及几何重建后把 UV / 材质搬回新网格。

读取（两种方式，按命令需要选）：
- load_scene / load_scene_meshes：按子网格读，各自保留材质（拆件类命令用）
- load_mesh_merged：把所有子网格合成一个整网格（贴图 / 重投影 UV 用）
- STEP/STP 走 gmsh 转网格（trimesh 自带的 STEP 后端要额外装 cascadio，不走）

保存：
- save_mesh：先直接写到目标路径，写不动就在内存里导出，再手动写入文件
- export_gltf_embedded：导出成单个 .gltf，buffer 和图片全部嵌进文件里
- attach_orphan_geometries：多场景 GLB 里没挂进场景图的几何补挂回去
  （不补挂的话，导出时会静默丢掉这部分几何）

UV / 材质搬运：减面这类操作会生成一套新顶点，原来的贴图坐标和材质不会
自动跟过去。remap_uv 把旧 UV 对到新顶点上，split_uv_seam 处理「绕一圈」
投影的接缝，material_visual_from 取回材质；搬不动的场合明确降级，交给
调用方写警告告知用户。
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, List, Optional

import numpy as np

from .errors import input_unreadable

STEP_EXTS = {".step", ".stp"}


def _is_step(file_path: str) -> bool:
    return Path(file_path).suffix.lower() in STEP_EXTS


def _is_empty_obj(file_path: str) -> bool:
    """OBJ 文本中没有任何 v 行 → 合法空网格（与 Tier0 处理空 OBJ 的规则一致，
    交给上层"空场景"处理，而不是让 trimesh 抛错归为输入不可读）。"""
    if Path(file_path).suffix.lower() != ".obj":
        return False
    try:
        with open(file_path, "r", encoding="utf-8", errors="ignore") as fh:
            for line in fh:
                if line.startswith("v ") or line.startswith("v\t"):
                    return False
    except OSError:
        return False
    return True


def load_scene(file_path: str):
    """加载网格为 trimesh.Scene（保留多子网格结构与各自材质）。

    STEP/STP 走 gmsh 网格化 + 颜色分组（与 inspect/convert 同路线）：
    trimesh 自带的 STEP 后端需要 cascadio（未声明依赖），不走。
    """
    if _is_step(file_path):
        from .services import step as step_svc

        groups, _bbox = step_svc.mesh_step_groups(file_path)
        if not groups:
            raise ValueError("STEP file produced no triangles; the file may contain no solid geometry or be corrupt")
        return step_svc.groups_to_scene(groups)

    import trimesh

    if _is_empty_obj(file_path):
        return trimesh.Scene()
    try:
        return trimesh.load(file_path, force="scene", process=False)
    except Exception as e:
        raise input_unreadable(f"Input parse failed ({Path(file_path).name}): {e}") from e


def load_scene_meshes(file_path: str):
    """场景 → [(name, Trimesh)]（丢弃空几何与点云）。"""
    import trimesh

    scene = load_scene(file_path)
    geos = getattr(scene, "geometry", {})
    return [
        (name, g)
        for name, g in geos.items()
        if isinstance(g, trimesh.Trimesh) and len(g.faces) > 0
    ]


def load_mesh_merged(file_path: str):
    """加载为单一 Trimesh（烘焙节点变换后合并；贴图/UV 重投影用）。"""
    import trimesh

    if _is_step(file_path):
        # STEP：gmsh 分组网格拼接为单一 Trimesh（后续统一重投影 UV，材质重置）
        from .services import step as step_svc

        groups, _bbox = step_svc.mesh_step_groups(file_path)
        if not groups:
            raise ValueError("STEP file produced no triangles; the file may contain no solid geometry or be corrupt")
        verts = [v for _, v, _f in groups]
        faces = []
        offset = 0
        for _, v, f in groups:
            faces.append(np.asarray(f, dtype=np.int64) + offset)
            offset += len(v)
        mesh = trimesh.Trimesh(vertices=np.vstack(verts), faces=np.vstack(faces), process=False)
        if len(mesh.vertices) == 0:
            raise ValueError("Model contains no geometry")
        return mesh

    if _is_empty_obj(file_path):
        return trimesh.Trimesh()
    try:
        mesh = trimesh.load(file_path, force="mesh", process=False)
    except Exception as e:
        raise input_unreadable(f"Input parse failed ({Path(file_path).name}): {e}") from e
    if not isinstance(mesh, trimesh.Trimesh) or len(mesh.vertices) == 0:
        raise ValueError("Model contains no geometry")
    return mesh


def save_mesh(mesh, out_path: str, file_type: Optional[str] = None) -> str:
    """保存网格：先尝试直接写到目标路径；失败则改为在内存里导出，再手动写入文件。"""
    try:
        mesh.export(out_path, file_type=file_type)
    except Exception:
        data = mesh.export(file_obj=None, file_type=file_type)
        if isinstance(data, (bytes, bytearray)):
            with open(out_path, "wb") as f:
                f.write(data)
        elif isinstance(data, str):
            with open(out_path, "w", encoding="utf-8") as f:
                f.write(data)
        else:
            raise
    return out_path


def attach_orphan_geometries(scene) -> List[str]:
    """把 scene.geometry 里没被场景图挂上的孤儿几何，按单位变换挂进默认场景。

    多场景 GLB：trimesh 加载时只把默认场景的层级挂进场景图，其余场景引用的
    几何就成了孤儿——导出时只保留场景图里挂着的几何，孤儿会被静默丢掉
    （曾把 3 个场景的 multimat.glb 导到只剩 1/3 的子网格）。返回被挂回的
    几何名，调用方要写 ORPHAN_GEOMETRY_ATTACHED 警告，保证「读到多少、
    导出多少」。
    """
    import numpy as np
    import trimesh

    if not isinstance(scene, trimesh.Scene):
        return []

    referenced = set()
    for node in scene.graph.nodes_geometry:
        _transform, geom_name = scene.graph[node]
        referenced.add(geom_name)

    attached: List[str] = []
    for name in list(scene.geometry.keys()):
        if name in referenced:
            continue
        scene.graph.update(
            frame_to=f"meshify_orphan::{name}",
            geometry=name,
            matrix=np.eye(4),
        )
        attached.append(name)
    return attached


def export_gltf_embedded(mesh, out_path: str) -> str:
    """导出单个 .gltf 文件：外部的 buffer 和图片全部转成 data URI 嵌进文件，
    交付时只有一个文件，不用带一串附属文件。"""
    import base64
    import json

    files = mesh.export(file_obj=None, file_type="gltf")
    main_key = next(k for k in files if str(k).lower().endswith(".gltf"))
    doc = json.loads(files[main_key])

    def _lookup(uri: str):
        for key in (uri, Path(uri).name):
            if key in files:
                return files[key]
        return None

    for buf in doc.get("buffers", []):
        uri = buf.get("uri", "")
        if uri and not uri.startswith("data:"):
            data = _lookup(uri)
            if data is None:
                raise ValueError(f"glTF export failed: external resource not found: {uri}")
            buf["uri"] = (
                "data:application/octet-stream;base64,"
                + base64.b64encode(bytes(data)).decode("ascii")
            )

    for img in doc.get("images", []):
        uri = img.get("uri", "")
        if uri and not uri.startswith("data:"):
            data = _lookup(uri)
            if data is None:
                raise ValueError(f"glTF export failed: external resource not found: {uri}")
            suffix = Path(uri).suffix.lower()
            mime = "image/png" if suffix == ".png" else "image/jpeg"
            img["uri"] = f"data:{mime};base64," + base64.b64encode(bytes(data)).decode("ascii")

    _dedup_data_uri_entries(doc)

    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False)
    return out_path


def _dedup_data_uri_entries(doc: Dict[str, Any]) -> None:
    """合并字节完全相同的 images/buffers 条目（trimesh 给共享贴图逐引用重复导出：
    同一 PNG 会在 images 里出现多次——uri 内嵌路径重复 data URI，bufferView 路径
    重复 (bufferView, mimeType) 对）。images 经 textures[].source 重映射，
    buffers 经 bufferViews[].buffer 重映射，再压缩索引。"""

    def _dedup(entries, ref_keys, ref_field, key_of):
        seen: Dict[Any, int] = {}
        remap: Dict[int, int] = {}
        for i, entry in enumerate(entries):
            key = key_of(entry)
            if key is None:
                continue
            if key in seen:
                remap[i] = seen[key]
            else:
                seen[key] = i
        if not remap:
            return
        keep = [i for i in range(len(entries)) if i not in remap]
        old_to_new = {old: new for new, old in enumerate(keep)}
        for holder in ref_keys:
            ref = holder.get(ref_field)
            if ref is None:
                continue
            holder[ref_field] = old_to_new[remap.get(ref, ref)]
        entries[:] = [entries[i] for i in keep]

    def _image_key(img):
        uri = img.get("uri", "")
        if uri.startswith("data:"):
            return ("uri", uri)
        # 无 uri → 二进制经 bufferView 引用；同 bufferView + 同 mime = 同一张图
        if "bufferView" in img:
            return ("bv", img.get("bufferView"), img.get("mimeType", ""))
        return None

    def _buffer_key(buf):
        uri = buf.get("uri", "")
        return ("uri", uri) if uri.startswith("data:") else None

    _dedup(doc.get("images", []), doc.get("textures", []), "source", _image_key)
    _dedup(doc.get("buffers", []), doc.get("bufferViews", []), "buffer", _buffer_key)


# ------------------------------------------------------------------
# UV / 材质搬运：减面等操作会生成一套新顶点，原网格的贴图坐标和材质
# 不会自动跟过去。这一节把外观搬回新几何——能精确搬就无损，
# 搬不动就明确降级，交给调用方写警告告知用户
# ------------------------------------------------------------------


def remap_uv(src_mesh, new_vertices) -> Optional[np.ndarray]:
    """把原网格的 UV 搬到几何重建后的新顶点上。

    - 新顶点和某个旧顶点位置重合：直接用那个顶点的 UV，无损
    - 新顶点是塌缩出来的新位置：找最近的三角形，用它三个顶点的 UV 插值
      （新位置本来就在原表面上，所以结果接近精确）
    """
    old_uv = getattr(src_mesh.visual, "uv", None)
    if old_uv is None or len(old_uv) == 0:
        return None

    try:
        from scipy.spatial import KDTree
    except ImportError:
        return None

    query = np.asarray(new_vertices, dtype=np.float64).reshape(-1, 3)
    uv = np.asarray(old_uv, dtype=np.float64)
    verts = np.asarray(src_mesh.vertices, dtype=np.float64)
    faces = np.asarray(src_mesh.faces, dtype=np.int64)

    tree = KDTree(verts)
    dist, nn = tree.query(query, k=min(4, len(verts)))
    dist = np.asarray(dist)
    nn = np.asarray(nn)
    if nn.ndim == 1:
        nn = nn.reshape(-1, 1)
        dist = dist.reshape(-1, 1)

    new_uv = np.empty((len(query), 2), dtype=np.float64)

    exact = dist[:, 0] <= 1e-9
    new_uv[exact] = uv[nn[exact, 0]]

    todo = np.where(~exact)[0]
    if len(todo) == 0:
        return new_uv

    incident: Dict[int, List[int]] = {}
    for fi, tri in enumerate(faces):
        for v in tri:
            incident.setdefault(int(v), []).append(fi)

    from trimesh.triangles import closest_point, points_to_barycentric

    for i in todo:
        cands = sorted({fi for v in nn[i] for fi in incident.get(int(v), ())})
        if not cands:
            new_uv[i] = uv[nn[i, 0]]
            continue
        tri_arr = verts[faces[cands]]
        pt_arr = np.repeat(query[i][None], len(cands), axis=0)
        cp = closest_point(tri_arr, pt_arr)
        winner = int(np.argmin(((cp - pt_arr) ** 2).sum(axis=1)))
        bary = points_to_barycentric(tri_arr[winner][None], cp[winner][None])[0]
        new_uv[i] = (bary[:, None] * uv[faces[cands[winner]]]).sum(axis=0)

    return new_uv


def split_uv_seam(mesh, uv) -> Optional[np.ndarray]:
    """拆开 UV 接缝上的顶点。柱面、球面这类「绕一圈」的投影，在首尾相接处
    u 会从 0 跳到 1，跨过这条缝的三角形会被拉成横穿整张贴图的条纹；把缝上
    的顶点复制一份、u 错开一个周期，两边就各自连续了。"""
    if uv is None:
        return None
    faces = np.asarray(mesh.faces)
    if len(faces) == 0 or len(uv) != len(mesh.vertices):
        return uv

    uv = np.asarray(uv, dtype=np.float64)
    u = uv[:, 0]
    uf = u[faces]
    crossing = np.asarray((uf.max(axis=1) - uf.min(axis=1)) > 0.5).nonzero()[0]
    if len(crossing) == 0:
        return uv

    tri = faces[crossing]
    need = np.unique(tri[uf[crossing] > 0.5])
    old_verts = np.asarray(mesh.vertices)

    remap = np.arange(len(old_verts) + len(need))
    remap[need] = np.arange(len(old_verts), len(old_verts) + len(need))

    mesh.vertices = np.vstack([old_verts, old_verts[need]])
    faces[crossing] = remap[tri]
    mesh.faces = faces

    new_uv = np.vstack([uv, uv[need]])
    new_uv[len(uv):, 0] -= 1.0
    return new_uv


def material_visual_from(src_mesh, target_vertices=None) -> Optional[Any]:
    """几何重建后，从原网格取回还能用的材质。

    - 没有贴图：材质直接拿来用，纯色外观无损
    - 有贴图且给了 target_vertices：把 UV 搬过去，贴图保住
    - 有贴图但 UV 搬不过去：去掉贴图只留颜色（降级，调用方必须写警告告知）
    """
    try:
        from trimesh.visual.texture import TextureVisuals
    except ImportError:
        return None

    mat = getattr(src_mesh.visual, "material", None)
    if mat is None:
        return None
    image = getattr(mat, "baseColorTexture", None) or getattr(mat, "image", None)
    if image is None:
        return TextureVisuals(material=mat)
    if target_vertices is not None:
        new_uv = remap_uv(src_mesh, target_vertices)
        if new_uv is not None:
            return TextureVisuals(uv=new_uv, material=mat)
    pm = mat.copy()
    # PBRMaterial 贴图在 baseColorTexture；SimpleMaterial 在 image
    pm.baseColorTexture = None
    pm.metallicRoughnessTexture = None
    pm.image = None
    return TextureVisuals(material=pm)


def material_visual_degraded(src_mesh) -> Optional[Any]:
    """仅保留 PBR 标量（baseColor/metallic/roughness）的降级材质（材质被迫降级、需要写警告时用）。"""
    return material_visual_from(src_mesh, target_vertices=None)
