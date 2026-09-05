# texture — five UV projections + texture binding

> English | [简体中文](zh-CN/texture.md)

## Syntax

```
meshify texture <input> --map <mode> [--image tex.png] [--metallic 0] [--roughness 0.8]
```

| `--map` | Projection | Good for |
|---|---|---|
| `uv` | Keep existing UVs | Input already has correct UVs |
| `planar` | XZ planar, top-down | Flat plates, bas-relief shapes |
| `cylindrical` | Unwrap around the Y axis | Cups, pipes; cap faces automatically switch to planar |
| `spherical` | Unwrap onto a sphere | Spheres and near-spheres; cap faces as above |
| `box` | Six-face triplanar, each face filled | Box-like parts, text and chart textures (the automatic fallback when no UVs exist) |

## Behavior

- `--map uv` on a model without UVs → automatic box projection + `AUTO_BOX_UV_GENERATED`
- UVs that are a color-block atlas from merging (signature: ≤64px textures) → ignored, box fallback
  + `ATLAS_UV_IGNORED` (pitfall 2)
- `--image`: binds a baseColor texture; non-PNG/JPEG inputs (webp/tiff/bmp/gif) are normalized to
  PNG + `TEXTURE_FORMAT_CONVERTED` (the glTF core spec only bakes in PNG/JPEG bitmaps)
- `--map uv` and `--image` are mutually exclusive (kept UVs give no guarantee the texture maps
  correctly) — exit 4
- `--metallic/--roughness`: PBR scalars applied to every material
- Inputs without materials (STL etc.): a default material is added so the texture has something to bind to

## Tier1-specific guards

- Cylinder/sphere seams: triangles whose u spans >0.5 across the seam get their seam vertices split
  (u-1), removing the smear band across the texture
- Cap faces (near-horizontal) degenerate under cylinder/sphere projection → switched to a filled XZ planar projection

## Output

`<input-name>.meshify/<input-name>.textured.glb` + report.

## Report highlights

`warnings` lists every approximation decision (AUTO_BOX_UV_GENERATED / ATLAS_UV_IGNORED /
TEXTURE_FORMAT_CONVERTED). Size can grow after texturing (textures move from external files into
the GLB) — a negative `byte_reduction` is normal.
