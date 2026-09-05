---
name: meshify
description: 3D model optimization toolkit. Mesh simplification (QEM decimation), splitting models into parts, UV projection and texturing, format conversion, LOD chains, and one-command web delivery compression. Reads glb/gltf/obj/stl/ply out of the box, step/stp CAD via the Tier1 kernel. Every command writes a meshify.report/v1 JSON manifest and exits with a semantic exit code. Use it whenever a model is too large, the face count is too high, a CAD file needs to become GLB, parts must be separated, or textures need shrinking. 中文任务同样触发：减面/拆件/贴图/格式转换/CAD 转 GLB。
---

# meshify — 3D mesh optimization agent skill

> English | [简体中文](SKILL.zh-CN.md)

## Scope

Prepares 3D models for delivery on the web, AR, and mobile: simplification, part splitting,
texturing, format conversion, LOD chains, one-command compression. Every command writes a
`meshify.report/v1` manifest (JSON) and reports results through semantic exit codes.

**Always report results to the user in the user's own language.** This document is English;
that choice only affects what you read, not what you say to the user.

- **Zero-install baseline**: runs on Node ≥ 18.17 (Tier0: WASM geometry kernel)
- **CAD support**: STEP/STP needs Tier1 (Python/uv + gmsh); when missing, exit 5 with install instructions
- **Never overwrites by default**: artifacts go to `<input-dir>/<input-name>.meshify/`, re-running is
  idempotent; overwriting requires an explicit `--overwrite`

## Support matrix (quick reference)

| Command | Purpose | Tier0 | Tier1 | Key parameters |
|---|---|---|---|---|
| inspect | Structure analysis (faces/materials/textures/bbox) | ✅ | ✅ (STEP) | `--json` |
| simplify | QEM decimation (per-submesh, materials kept) | ✅ | ✅ | `--ratio 0.5`, `--target-faces`, `--min-faces` |
| segment | Split: connected/plane/semantic | ✅ | ✅ | `--mode`, `--axis x --position 0.5`, `--cap` |
| texture | Five UV projections + texture binding | ✅ | ✅ | `--map box`, `--image`, `--metallic/--roughness` |
| convert | glb/gltf/obj/stl/ply interconversion | ✅ | ✅ (reads STEP) | `--to glb`, `--up-axis x\|auto` (upright models authored lying down / auto-detect) |
| lod | Multi-level LOD chain | ✅ | ✅ | `--levels 3 --ratio 0.5` |
| optimize | One-command web delivery (meshopt+WebP) | ✅ | ⚠️ uncompressed baseline | `--ratio`, `--texture-size` |
| doctor | Environment check + install guidance | ✅ | detects | `--json`, `--install-uv` |

Input formats: `glb gltf obj stl ply` (Tier0 reads directly) / `step stp` (Tier1 only).
FBX and others are not supported (exit 3).

## Decision tree (in order)

```
Got a model
  ├─ Don't know its structure? → meshify inspect model.glb --json   # faces/submeshes/materials/textures/animations
  ├─ It's a STEP? → meshify doctor first to confirm Tier1; install if needed (references/cad-step.md)
  ├─ Too large / too many faces?
  │    ├─ Single object → meshify simplify --ratio 0.5
  │    ├─ Assembly to split → meshify segment --mode connected
  │    └─ Cut in half → meshify segment --mode plane --axis x
  ├─ Needs textures → meshify texture --map box --image tex.png
  ├─ Needs another format → meshify convert --to stl|obj|ply|gltf
  ├─ Needs progressive loading → meshify lod --levels 3 --ratio 0.5
  └─ Web delivery in one step → meshify optimize --ratio 0.5 --texture-size 2048
After each command: read report.json (or --json stdout) and check warnings and reduction metrics
```

**Artifact commands default to `--preview-html`** (simplify/segment/texture/convert/lod/optimize):
it generates a before/after comparison page, the fastest way to verify the result by eye. Omit the
flag when the user explicitly declines a preview, or for batch/unattended runs (the HTML embeds the
model as base64 at roughly 1.33x the artifact size; three.js loads from a CDN and needs network).

**What semantic mode is not**: `--mode semantic` clusters by orientation + position; it does not
recognize parts. Use connected to split an assembly; use semantic only to partition by appearance
(flat/curved/differently oriented regions).

## Command examples

```bash
# Structure analysis (the agent's first step; --json for the full manifest)
meshify inspect model.glb --json

# Simplify to 30% (per-submesh, materials kept; submeshes <200 faces skipped with a warning)
meshify simplify model.glb --ratio 0.3 --preview-html

# Exact target face count + error bound
meshify simplify model.glb --target-faces 50000 --error 0.005 --preview-html

# Connected-component split (first choice for assemblies; drops fragments <50 faces)
meshify segment model.glb --mode connected --min-faces 50 --preview-html

# Plane cut: slider semantics (-1..1 mapped across the bbox) or native coordinates
meshify segment model.glb --mode plane --axis x --position 0 --preview-html
meshify segment model.glb --mode plane --origin "0,10,0" --normal "0,1,0"

# Texture (box projection; generates UVs when missing and discloses it)
meshify texture model.glb --map box --image diffuse.png --metallic 0.1 --preview-html

# Format conversion (STL for slicers)
meshify convert model.glb --to stl --preview-html

# Three LOD levels (100%/50%/25%)
meshify lod model.glb --levels 3 --ratio 0.5 --preview-html

# Web delivery: simplify + textures capped at 2048 + meshopt compression
meshify optimize model.glb --ratio 0.5 --texture-size 2048 --preview-html

# STEP (CAD) → GLB: needs Tier1
meshify convert part.step --to glb

# A part authored lying down (real up axis is not the CAD-default Z): upright it while converting
meshify convert part.step --to glb --up-axis auto --preview-html

# Environment check (run before and after installing Tier1)
meshify doctor
```

Global options (all commands): `-o <path>` explicit output path, `--json` manifest to stdout,
`--overwrite`, `--tier auto|ts|py`, `--force` to process an oversize input once. `--preview-html`
follows the default policy above: artifact commands include it unless the flag is omitted.

## Reading the report (meshify.report/v1)

Each command writes a manifest at `<input-name>.meshify/<input-name>.<op>.report.json` (reports are
the tool's own logs and may be overwritten automatically; only model artifacts are governed by
`--overwrite`). With `--json` the same content goes to stdout.

```jsonc
{
  "schema": "meshify.report/v1",
  "tool": { "name": "meshify", "version": "0.1.0", "tier": "ts-wasm" },  // or python-uv
  "command": "simplify",
  "input":  { "path": "...", "format": "glb", "vertices": 54, "faces": 32,
              "meshes": [ { "name": "boxA", "material": "red", "has_uv": true, ... } ],
              "materials": 3, "textures": [], "bbox": [[...],[...]], "has_animation": false },
  "output": { "path": "...glb", "bytes": 441100, "vertices": 14082, "faces": 14082,
              "files": [ { "path": "...", "bytes": 441100, "role": "asset" } ] },
  "params": { "ratio": 0.3 },
  "metrics": { "face_reduction": 0.7, "byte_reduction": 0.47, "duration_ms": 200 },
  "warnings": [ { "code": "SMALL_MESH_SKIPPED", "message": "...", "mesh": "boxA" } ],
  "errors": [],
  "exit_code": 0
}
```

**How to read it**: `metrics.face_reduction/byte_reduction` shows the effect; `warnings[].code`
shows degradations (not failures); non-empty `errors` means failure. Full warning-code table in
references/troubleshooting.md.

**Failed runs also produce a manifest**: non-zero exits (unreadable input, parameter conflicts,
empty scene, and other early failures) still write a minimal manifest (`errors[]` with the reason,
`params.failed_early: true`, input stats zeroed as a fallback), and the `--json` stdout contract is
unchanged. Always "parse the stdout manifest first; on failure read errors + exit_code".
Field-level detail in references/report-schema.md.

## Exit codes (decide by code)

| Code | Meaning | Next step |
|---|---|---|
| 0 | Success | Read the manifest |
| 2 | Input unreadable | Check path/permissions |
| 3 | Format unsupported | Convert to glb and retry (export FBX etc. through a DCC first) |
| 4 | Parameter conflict / overwrite refused | Fix parameters per the message; add `--overwrite` to confirm |
| 5 | Tier1 unavailable | `meshify doctor --install-uv`, then `uv sync` (cad-step.md) |
| 6 | Algorithm failure | Adjust parameters (plane position/cluster count), or segment first |
| 7 | Resource limit / partial success | `--force`, or split into batches |
| 8 | Internal error | Attach report.json to the bug report |

## Tier routing (when Python runs)

1. Input contains **animation/skinning/morphs** → forced Tier0 (the trimesh pipeline would drop
   animation), writes `SKIN_ANIMATION_PRESERVED`
2. Input is **STEP** → forced Tier1; when not installed → exit 5 + install instructions
   (no TS fallback; this is a capability boundary, not a malfunction)
3. Everything else defaults to Tier0; `--tier py` explicitly requests Tier1, exit 5 if unavailable
4. meshopt/draco/WebP compression in `optimize` is Tier0-only — under `--tier py` the output is an
   uncompressed baseline with a `TIER_DOWNGRADED` disclosure

Details in references/tiering.md.

## Output layout

```
model.glb
model.meshify/
  ├─ model.inspect.report.json      # per-command reports
  ├─ model.simplified.glb           # single-file artifact
  ├─ model.segment-plane.glb        # merged segmentation artifact (part-level scene)
  ├─ model.segment-plane/part_000.glb ...   # Tier1 multi-part directory
  ├─ model.lod0.glb / lod1.glb ...  # LOD chain (Tier0)
  └─ *.preview.html                 # --preview-html comparison page (self-contained single file, opens directly in a browser)
```

## Troubleshooting pointers

- Environment problems (WASM load failure / uv missing / low disk) → `meshify doctor`, or references/troubleshooting.md
- STEP conversion failures / precision tuning → references/cad-step.md
- Per-command parameter detail → references/{simplify,segment,texture,convert,optimize}.md
- Dual-kernel differences and consistency → references/tiering.md; host compatibility → references/support-matrix.md
- Manifest field-level documentation → references/report-schema.md
- Chinese translations (for human readers) → SKILL.zh-CN.md + references/zh-CN/; these English
  files are the operative copy for the agent
