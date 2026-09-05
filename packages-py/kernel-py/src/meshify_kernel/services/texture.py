"""五投影 UV 贴图（迁移自 maestro model_edit_texture.py）。

- uv / planar / cylindrical / spherical / box
- 坑 2：色块图集 UV 检测 → ATLAS_UV_IGNORED + 盒式回退
- 无 UV → AUTO_BOX_UV_GENERATED（盒式，文字可读）
- 柱/球面帽面感知 + 接缝分裂（split_uv_seam）
- metallic/roughness 覆盖（meshify 增）
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

import numpy as np

from .. import mesh_utils as mu
from ..manifest import warn


def texture_file(
    input_path: str,
    output_path: str,
    *,
    map_mode: str,
    image_path: Optional[str] = None,
    metallic: Optional[float] = None,
    roughness: Optional[float] = None,
    overwrite: bool = False,
) -> Dict[str, Any]:
    from PIL import Image
    from trimesh.visual.material import PBRMaterial
    from trimesh.visual.texture import TextureVisuals

    warnings: List[Dict[str, Any]] = []
    mesh = mu.load_mesh_merged(input_path)
    if len(mesh.vertices) == 0:
        raise ValueError("Model contains no vertices")

    if map_mode not in {"uv", "planar", "cylindrical", "spherical", "box"}:
        raise ValueError(f"Unsupported map mode: {map_mode}")

    texture = None
    if image_path:
        texture = Image.open(image_path).convert("RGBA")

    material = PBRMaterial(
        baseColorFactor=[255, 255, 255, 255],
        metallicFactor=0.0 if metallic is None else float(metallic),
        roughnessFactor=0.8 if roughness is None else float(roughness),
        doubleSided=True,
    )
    if texture is not None:
        material.baseColorTexture = texture
        warnings.append(warn("DOUBLE_SIDED_FORCED", "Textured output material is doubleSided (open shells vs. backface culling)"))

    if map_mode == "uv":
        uvs = getattr(mesh.visual, "uv", None)
        if uvs is not None and len(uvs) > 0 and _is_atlas_artifact(mesh.visual):
            warnings.append(
                warn("ATLAS_UV_IGNORED", "Model UVs are a color-block atlas produced by merging; ignored, box UVs generated instead")
            )
            uvs = None
        if uvs is None or len(uvs) == 0:
            warnings.append(warn("AUTO_BOX_UV_GENERATED", "Model has no UV coordinates; box UVs generated automatically"))
            uvs = _box_uv(mesh)
    elif map_mode == "planar":
        uvs = _planar_uv(mesh)
    elif map_mode == "cylindrical":
        uvs = _cylindrical_uv(mesh)
    elif map_mode == "spherical":
        uvs = _spherical_uv(mesh)
    else:
        uvs = _box_uv(mesh)

    mesh.visual = TextureVisuals(uv=uvs, material=material)
    mu.save_mesh(mesh, output_path, file_type="glb")
    return {
        "output_path": output_path,
        "vertices": int(len(mesh.vertices)),
        "faces": int(len(mesh.faces)),
        "warnings": warnings,
    }


# ------------------------------------------------------------------
# UV 投影（maestro 原样迁移）
# ------------------------------------------------------------------


def _planar_uv(mesh) -> np.ndarray:
    verts = np.asarray(mesh.vertices)
    x = verts[:, 0]
    z = verts[:, 2]
    u = (x - x.min()) / (x.max() - x.min() + 1e-9)
    v = (z.max() - z) / (z.max() - z.min() + 1e-9)
    return np.stack([u, v], axis=1)


def _cylindrical_uv(mesh) -> np.ndarray:
    verts = np.asarray(mesh.vertices)
    theta = np.arctan2(verts[:, 2], verts[:, 0])
    u = (np.pi - theta) / (2 * np.pi)
    y = verts[:, 1]
    v = (y - y.min()) / (y.max() - y.min() + 1e-9)
    uv = np.stack([u, v], axis=1)
    uv = mu.split_uv_seam(mesh, uv)
    cap = _cap_vertex_mask(mesh)
    if cap.any():
        uv[cap] = _planar_xz_uv(np.asarray(mesh.vertices)[cap])
    return uv


def _spherical_uv(mesh) -> np.ndarray:
    verts = np.asarray(mesh.vertices)
    centered = verts - verts.mean(axis=0)
    r = np.linalg.norm(centered, axis=1) + 1e-9
    theta = np.arctan2(centered[:, 2], centered[:, 0])
    phi = np.arccos(np.clip(centered[:, 1] / r, -1, 1))
    u = (np.pi - theta) / (2 * np.pi)
    v = 1.0 - phi / np.pi
    uv = np.stack([u, v], axis=1)
    uv = mu.split_uv_seam(mesh, uv)
    cap = _cap_vertex_mask(mesh)
    if cap.any():
        uv[cap] = _planar_xz_uv(np.asarray(mesh.vertices)[cap])
    return uv


def _box_uv(mesh) -> np.ndarray:
    verts = np.asarray(mesh.vertices, dtype=np.float64)
    faces = np.asarray(mesh.faces)
    fn = np.asarray(mesh.face_normals, dtype=np.float64)
    mn = verts.min(axis=0)
    rng = np.maximum(verts.max(axis=0) - mn, 1e-9)
    dom = np.argmax(np.abs(fn), axis=1)
    key = dom * 2 + (fn[np.arange(len(fn)), dom] > 0)
    tri = (verts[faces] - mn) / rng
    corner_u = np.zeros((len(faces), 3))
    corner_v = np.zeros((len(faces), 3))
    for k in np.unique(key):
        m = key == k
        axis, pos = int(k) // 2, bool(k % 2)
        if axis == 1:
            cu, cv = tri[m, :, 0], tri[m, :, 2]
            if pos:
                cv = 1 - cv
        else:
            cv = tri[m, :, 1]
            if axis == 2:
                cu = tri[m, :, 0]
                if not pos:
                    cu = 1 - cu
            else:
                cu = tri[m, :, 2]
                if pos:
                    cu = 1 - cu
        corner_u[m] = cu
        corner_v[m] = cv
    pair = faces.reshape(-1).astype(np.int64) * 8 + np.repeat(key, 3)
    uniq, first, inv = np.unique(pair, return_index=True, return_inverse=True)
    mesh.vertices = verts[uniq // 8]
    mesh.faces = inv.reshape(-1, 3)
    return np.stack([corner_u.reshape(-1)[first], corner_v.reshape(-1)[first]], axis=1)


def _cap_vertex_mask(mesh) -> np.ndarray:
    faces = np.asarray(mesh.faces)
    fn = np.abs(np.asarray(mesh.face_normals))
    cap_faces = (fn[:, 1] > fn[:, 0]) & (fn[:, 1] > fn[:, 2])
    cap = np.zeros(len(mesh.vertices), dtype=bool)
    if cap_faces.any():
        cap[np.unique(faces[cap_faces])] = True
    return cap


def _planar_xz_uv(verts) -> np.ndarray:
    x = verts[:, 0]
    z = verts[:, 2]
    u = (x - x.min()) / (x.max() - x.min() + 1e-9)
    v = (z.max() - z) / (z.max() - z.min() + 1e-9)
    return np.stack([u, v], axis=1)


def _is_atlas_artifact(visual) -> bool:
    mat = getattr(visual, "material", None)
    if mat is None:
        return False
    image = getattr(mat, "baseColorTexture", None) or getattr(mat, "image", None)
    if image is None:
        return False
    try:
        w, h = image.size
    except Exception:
        return False
    return max(w, h) <= 64
