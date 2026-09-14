# simplify — QEM decimation

> English | [简体中文](zh-CN/simplify.md)

## Syntax

```
meshify simplify <input> [--ratio 0.5] [--target-faces N] [--error 0.01]
                  [--min-faces 200] [--aggressiveness 7] [--no-keep-border] [--merge]
```

| Parameter | Default | Notes |
|---|---|---|
| `--ratio <n>` | 0.5 | Fraction of faces to keep, (0.01–1]. Mutually exclusive with `--target-faces` |
| `--target-faces <n>` | — | Exact target face count (distributed proportionally across submeshes). Mutually exclusive with `--ratio`; passing both is exit 4 |
| `--error <n>` | 0.01 | Error bound (normalized 0–1); faces whose simplification error exceeds it are kept |
| `--min-faces <n>` | 200 | Submeshes below this face count are skipped (degradation risk outweighs the gain), writes `SMALL_MESH_SKIPPED` |
| `--aggressiveness <n>` | 7 | QEM aggressiveness 1–10; higher is more conservative (Tier1 pyfqmr semantics) |
| `--no-keep-border` | on | Disables border preservation (borders of open shells can collapse into holes — usually leave this on) |
| `--merge` | off | Simplify across submeshes (drops submesh boundaries; majority material kept) |

## Behavior

- **Per-submesh processing (pitfall 1 guard)**: every submesh of a multi-material model is
  simplified independently with materials kept as-is; nothing collapses into an untextured white model
- **Tier0** (meshoptimizer WASM): `--error` is active; the manifest carries `max_error_normalized`;
  simplified textured meshes disclose `UV_REMAP_APPROXIMATED` (textures sample from the retained
  vertex subset in collapsed regions)
- **Tier1** (pyfqmr): `--aggressiveness` is active; textured meshes are not welded by position
  (duplicate seam vertices are kept), and UVs of collapsed vertices are remapped by barycentric
  interpolation over the nearest triangle (same `UV_REMAP_APPROXIMATED` code)
- **UV seam floor (both tiers)**: deep decimation on UV-bearing meshes is capped by UV island seams —
  seam vertices are split in index space and act as locked borders the decimator cannot collapse across,
  so `--no-keep-border`/`--merge` do not help. When a UV-bearing submesh ends far above its requested
  target, `UV_SEAM_DECIMATION_LIMITED` discloses it; simplify before texturing to reach lower counts
- Animated/skinned input is forced to Tier0 (`SKIN_ANIMATION_PRESERVED`)

## Output

`<input-name>.meshify/<input-name>.simplified.glb` + a matching `.report.json`.

## Report highlights

```jsonc
"metrics": { "face_reduction": 0.7, "ratio_actual": 0.3, "max_error_normalized": 0.004 }
```

`ratio_actual` is the fraction actually kept (it can exceed the requested value when min-faces skips
submeshes, or when UV seams cap decimation — `UV_SEAM_DECIMATION_LIMITED`).

## Advice

- Web display: start at `--ratio 0.3 --error 0.01`; push further only while `max_error_normalized` stays under 0.01
- **Order matters: simplify before texturing.** Projection-generated UV islands split seam vertices,
  which act as locked borders during decimation; texturing first caps how far you can later simplify.
  When the model has no UVs yet, simplify first, then `texture`
- Don't simplify models under 1000 faces total (little gain, visible degradation; min-faces blocks most of it for you)
- For heavier reduction plus size compression, go straight to `optimize` (simplification + meshopt in one pipeline)
