# tiering — dual-kernel routing

> English | [简体中文](zh-CN/tiering.md)

## Why two tiers

| | Tier0 (ts-wasm) | Tier1 (python-uv) |
|---|---|---|
| Runtime | Node ≥ 18.17, nothing else to install | Python ≥ 3.12 (managed by uv) |
| Geometry | gltf-transform + meshoptimizer WASM + earcut + sharp | trimesh + pyfqmr + sklearn + gmsh (OCC) |
| Exclusive capabilities | meshopt/draco compression, WebP textures, structural animation/skinning preservation | **STEP/STP CAD reading**, cross-submesh welding into solids |
| Startup | ~0.1s | ~2s cold start (uv run) |

## Routing rules (tier-orchestrator, hard rules)

1. **Animation/skinning/morph input → forced Tier0**
   The trimesh pipeline drops animation on load (verified against maestro). When animations/skins
   are detected, the routing layer switches to Tier0 and writes `SKIN_ANIMATION_PRESERVED`.
   `--tier py` is intercepted too.
2. **STEP input → forced Tier1**
   Tier0 has no parser. Tier1 not ready → exit 5 + install instructions. **There is no fallback
   path; this is a capability boundary, not a malfunction.**
3. Everything else defaults to Tier0; `--tier py` explicitly requests Tier1 (exit 5 if unavailable).
4. Environment probing is cached for 24h (`~/.meshify/tier-env.json`); `meshify doctor` re-probes
   live every time and refreshes that cache.

## Traces in the manifest

- `tool.tier`: `ts-wasm` or `python-uv`
- `metrics.tier_note`: routing note for this run (e.g. "connected: 3 components, 3 parts output")
- Downgrades / animation preservation → matching warning codes
  (`TIER_DOWNGRADED` / `SKIN_ANIMATION_PRESERVED`)

## Cross-kernel consistency

For the same input, both kernels' `inspect` statistics (vertices/faces/submeshes/material count/
bbox) follow the file's declarations and agree numerically (a consistency test guards this).
The concrete geometry produced by simplify/segment is **not guaranteed vertex-identical across
kernels** (different QEM implementations), but both satisfy their own quality bars (face-count
ratio, watertightness, material preservation).

## Tier1 output differences

- segment/lod multi-part output goes to `output_dir/part_000.glb…` (Tier0 produces a single GLB
  with multiple nodes, or separate lodN files)
- optimize has no geometry compression (`TIER_DOWNGRADED`)
- `--preview-html` still works (generated on successful artifacts); but STEP and other non-glTF
  inputs have no browser-renderable form, so the before side is missing → single-viewport page +
  `PREVIEW_BEFORE_UNAVAILABLE` disclosure; non-GLB artifacts (convert --to stl etc.) skip the page entirely
- The part-file overwrite convention is identical on both sides: refuse if the file exists (exit 4),
  overwrite only with `--overwrite`
