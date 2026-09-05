# optimize — one-command web delivery

> English | [简体中文](zh-CN/optimize.md)

## Syntax

```
meshify optimize <input> [--ratio 0.5] [--error 0.01] [--compression meshopt]
                  [--texture-format webp] [--texture-size 2048] [--min-faces 200]
```

| Parameter | Default | Notes |
|---|---|---|
| `--ratio <n>` | no simplification | Simplifies only when given (same semantics as simplify) |
| `--error <n>` | 0.01 | Simplification error bound |
| `--compression` | meshopt | `meshopt` / `draco` / `none`. draco needs an optional dependency; when missing it is skipped with `DRACO_UNAVAILABLE` |
| `--texture-format` | webp | `webp` / `jpeg` / `png` / `none` (leave textures alone). webp capped at the glTF core GPU limit of 2048 has the best compatibility |
| `--texture-size <n>` | unlimited | Max texture long edge; larger textures are downsampled (pitfall 11: downsampling must disclose `TEXTURE_DOWNSCALED`) |
| `--min-faces <n>` | 200 | Simplification skip threshold |

## Pipeline order (Tier0)

```
weld → prune → [optional simplify] → [texture compression/downscaling] → meshopt|draco geometry compression
```

The order follows gltf-transform conventions: weld first (merged indices compress better), prune
last to clear orphaned resources.

## Tier1 (--tier py) boundary

meshopt/draco are WASM encoders (Tier0 only). The Tier1 route outputs an **uncompressed baseline**
and writes a `TIER_DOWNGRADED` disclosure — don't pass `--tier py` when you need compression.

## Output

`<input-name>.meshify/<input-name>.optimized.glb`; `--preview-html` adds a comparison page.

## Report highlights

```jsonc
"metrics": { "face_reduction": 0.5, "byte_reduction": 0.82 }
```

Most of the size reduction comes from textures (WebP + downscaling); meshopt geometry typically
saves another 30–60% of the vertex buffer.

## Preview page (--preview-html)

A self-contained single HTML file (GLB embedded as base64, three.js from a CDN): two linked
viewports, automatic flatShading for meshes missing NORMAL (pitfall 10), ambient light adapted to
average texture brightness to prevent blowout (pitfall 11), and a manifest metrics panel in the
bottom-right corner. Open this file to show the user the result or to check for degradation.
