# cad-step — STEP/STP CAD handling (Tier1)

> English | [简体中文](zh-CN/cad-step.md)

STEP (ISO 10303) is the neutral B-rep format of industrial CAD, and **only Tier1 can read it**
(gmsh bundles the OpenCASCADE kernel). Tier0 has no parser and is not supposed to — STEP input
with Tier1 not ready gives exit 5 plus install instructions.

## Installation (one time)

```bash
meshify doctor --install-uv        # installs uv (single-file installer, nothing system-wide)
cd <repo>/packages-py/kernel-py && uv sync
meshify doctor                     # verify: Tier1 deep-import check [ok]
```

On slow links to PyPI (mainland China), set a mirror first (PowerShell `set` / bash `export`):

```
UV_DEFAULT_INDEX=https://pypi.tuna.tsinghua.edu.cn/simple
```

Dependencies are around 200 MB (gmsh's bundled OCC kernel is the bulk); Python ≥ 3.12 is managed
by uv automatically.

## Conversion semantics

```bash
meshify convert part.step --to glb
meshify inspect part.step          # statistics only, no artifact written
meshify simplify part.step --ratio 0.3     # convert then simplify (or do it in two steps for more control)
```

- **Meshing precision**: target edge length = bbox diagonal / resolution (default 100). For finer
  or coarser output, run `convert` first with the `resolution` parameter (same on inspect), then
  process the result
- **Color grouping** (styled_item, AP203/AP214): parts are grouped by CAD color, each group becomes
  an independent PBR submesh; files without colors fall back to a light matte gray
  (metallic 0 / roughness 0.8, avoiding a bare white model)
- Colors attached to the solid but not propagated to faces: the owning solid's color is used
  (gmsh adjacencies)
- **Up-axis normalization**: STEP coordinates are treated as Z-up per CAD convention, while glTF
  requires Y-up — outputs are uniformly rotated (x,y,z)→(x,z,−y), disclosed in the manifest as
  `UP_AXIS_NORMALIZED`. Some viewers guess Z-up automatically and display the original CAD
  ("looks fine"), but in strict Y-up renderers (three.js and the web stack generally) an
  unconverted model lies on its side
- **Parts authored lying down** (assembly coordinate system rotated, real up axis is not Z): STEP
  carries no "which way is up" information, and when the default Z-up guess is wrong the output
  lies on its side — `--up-axis` names the axis that should point up and rotates accordingly:

  ```bash
  meshify convert part.step --to glb --up-axis x      # part height runs along source X
  meshify convert part.step --to glb --up-axis=-x     # opposite direction (negative values must use = syntax)
  meshify convert part.step --to glb --up-axis auto   # detect from geometry
  ```

  Values: `x|y|z` (optionally `-` prefixed for the negative direction) or `auto` (default `z`).
  Only the convert command supports it, and only STEP input honors it (other formats exit 4);
  the direct-read STEP path of simplify and friends still assumes Z-up — convert first if you
  need the correction. How to decide: look at the render, find which dimension is "height",
  then check which source axis that dimension runs along in CAD

- **How `--up-axis auto` decides, and where it refuses** (conservative policy: rather refuse than guess):
  - Evidence = mounting-hole patterns on the base plate — coplanar clusters of small-radius
    cylindrical holes (≥3, spread laterally). A coarse-mesh point-containment test separates
    real holes (center inside a cavity) from boss steps (center inside solid material, e.g. the
    segments of a terminal stud — axially coplanar but not a mounting pattern)
  - Exactly one axis reaches the hole-vote threshold and leads the runner-up by ≥1.5x → that's
    the axis; which end of the bbox the hole cluster sits on gives the sign (the hole face is the
    bottom); when the cluster sits mid-body (side mounting ears), planar-area shares serve as
    secondary evidence
  - High confidence: manifest writes `UP_AXIS_AUTO` (verdict + evidence) and
    `params.up_axis_resolved`
  - Low confidence (symmetric parts / no mounting holes / multi-directional hole patterns / holes
    on both ends) → **exit 4, refusing and listing candidate evidence** (per-axis normal-facing
    plane counts / area shares). Inspect the render, pick the axis yourself, and pass `x|y|z`
    explicitly
  - Typical hits: chassis/panel parts with a base plate and corner holes, DIN-rail electricals.
    Typical refusals: cubes, spheres, hole-free castings

## Recommended pipeline after meshing

OCC meshes are geometrically exact but face-heavy triangle soup:

```bash
meshify convert part.step --to glb              # → part.converted-glb.glb
meshify simplify part.converted-glb.glb --ratio 0.1 --error 0.002
meshify optimize part.converted-glb.glb --texture-size 1024   # one more layer of size reduction
```

## Common problems

| Symptom | Cause / fix |
|---|---|
| `exit 5` | Tier1 not installed/synced — follow the install steps above; `meshify doctor` shows which check FAILs |
| `STEP file produced no triangles` | File contains only wireframes/points, or is corrupt; confirm it holds solids in CAD software |
| Face count explodes | OCC surface refinement; lower the resolution parameter (e.g. 50) |
| Colors lost | The source file has no styled_item colors at all; add materials afterwards with the texture command |
| Two-tone solid comes out single-color after splitting | Tier1 plane cut takes the solid's majority color (keeps the cross-section watertight); connected keeps all colors |
