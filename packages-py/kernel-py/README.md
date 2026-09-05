# meshify-kernel (Tier1)

> English | [简体中文](README.zh-CN.md)

The Python augmentation kernel of meshify. The CLI invokes it as a one-shot subprocess:

```
uv run python -m meshify_kernel <payload.json>
```

stdout carries the full `meshify.report/v1` manifest; the process exit code equals
manifest.exit_code (same semantics as the TS side).

## Capabilities

- **STEP/STP CAD reading** (gmsh OpenCASCADE kernel, grouped by color with independent PBR
  materials) — Tier0 cannot do this; it is the primary reason Tier1 exists
- QEM simplification (pyfqmr, per-submesh with materials kept + nearest-neighbor UV remapping)
- Three segmentation modes (connected / plane / semantic, with cross-submesh welding)
- Five-projection UV texturing (uv/planar/cylindrical/spherical/box)
- Format conversion (glb/gltf/obj/stl/ply)
- LOD chains, optimize (uncompressed baseline: geometry compression is a Tier0 WASM capability;
  output writes `TIER_DOWNGRADED`)

## Install

```
cd packages-py/kernel-py
uv sync
```

On slow links to PyPI (mainland China), configure a mirror first:
`set UV_DEFAULT_INDEX=https://pypi.tuna.tsinghua.edu.cn/simple`

## Origin of the service layer

Migrated from the maestro backend `services/model_edit/` (simplify/segment/texture/STEP),
with FastAPI/DB stripped out; geometry algorithms and pitfall guards are preserved as-is, and
warnings became contract warning codes in the manifest.
