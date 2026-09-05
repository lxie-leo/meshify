# Meshify

> A 3D model optimization CLI: simplification, part splitting, texturing, format conversion, LOD,
> and web-delivery compression through a single `meshify` command. Every run writes a
> `meshify.report/v1` structured report and a semantic exit code for agents to consume.

English | [简体中文](README.zh-CN.md)

[![CI](https://github.com/lxie-leo/meshify/actions/workflows/ci.yml/badge.svg)](https://github.com/lxie-leo/meshify/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-informational.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A518.17-339933?logo=node.js&logoColor=white)](packages/cli/package.json)
[![Tier0](https://img.shields.io/badge/Tier0-zero--python-646CFF?logo=typescript&logoColor=white)](#two-kernels-tiering)

Meshify prepares 3D models for delivery on the web, AR, and mobile. It is designed first for AI
agents (Claude Code, Cursor, Codex, and others): every command emits a structured manifest, and
degradations such as generated UVs or stripped textures are always disclosed as warning codes in
the report. It is also a CLI that developers can use directly.

`glb` / `gltf` / `obj` / `stl` / `ply` work out of the box; `step` / `stp` (CAD) goes through the
Tier1 kernel.

## Features

- Eight commands: `inspect` / `simplify` / `segment` / `texture` / `convert` / `lod` / `optimize` / `doctor`
- Failed runs still write a structured error report (`errors[]` + `failed_early`), not just an exit code
- The Tier0 kernel is pure Node + WASM (gltf-transform / meshoptimizer / earcut) and runs on
  Node ≥ 18.17; STEP/STP goes to the Tier1 Python kernel (uv-managed, gmsh / OpenCASCADE), with
  install guidance returned on exit 5
- Source files are read-only; artifacts go to `<input-name>.meshify/`; overwriting requires an
  explicit `--overwrite`
- Quality assertions are kernel-independent (custom Hausdorff sampling / boundary-edge
  watertightness counting), with dedicated cross-kernel consistency tests
- `--preview-html` generates a single-file before/after comparison page

## Install

**From GitHub into an agent host** (recommended, no clone needed;
[skills CLI](https://github.com/vercel-labs/skills)):

```bash
# auto-detect installed hosts, choose interactively
npx skills add lxie-leo/meshify --skill meshify

# or target a host explicitly (-g installs to the user-level global directory)
npx skills add lxie-leo/meshify --skill meshify -a claude-code   # Claude Code
npx skills add lxie-leo/meshify --skill meshify -a cursor        # Cursor
npx skills add lxie-leo/meshify --skill meshify -a codex         # Codex
npx skills add lxie-leo/meshify --skill meshify -a qoder-cn      # Qoder (international: -a qoder)
npx skills add lxie-leo/meshify --skill meshify -a codebuddy     # CodeBuddy
npx skills add lxie-leo/meshify --skill meshify -a universal     # Comate etc. (installs to .agents/skills/, auto-loaded by Comate)

npx skills update                                                # update installed skills
```

On Windows, symlinks require Developer Mode; without it, add `--copy` to install by copying.
Cursor also works through its UI: Customize → Rules → Add Rule → Remote Rule (GitHub) → point it
at this repository.

**Claude Code native plugin marketplace** (the same path works in the VSCode extension's
`/plugins` → Marketplaces):

```bash
claude plugin marketplace add lxie-leo/meshify
claude plugin install meshify@meshify-skills
```

> Note: the remote installs above deliver the skill documentation (`SKILL.md` + `references/`).
> The CLI itself currently needs to be built from this repository (see below); `npx meshify`
> becomes available once published to npm.

**From a clone** (the installer builds the CLI and copies the skill into detected host directories):

```bash
# PowerShell
powershell -ExecutionPolicy Bypass -File skills/meshify/scripts/install.ps1
# POSIX sh (Git Bash / macOS / Linux)
sh skills/meshify/scripts/install.sh
```

The installer copies `SKILL.md + references/` into host skills directories, builds the CLI if
missing, and runs `meshify doctor` as a self-check. See [skills/meshify/SKILL.md](skills/meshify/SKILL.md)
for skill usage.

**From the repository**:

```bash
pnpm install && pnpm build
pnpm meshify --help
```

## Quick start

```bash
# Structure first: faces / submeshes / materials / textures / bounding box
$ meshify inspect fixtures/glb/multimat.glb --json
{
  "schema": "meshify.report/v1",
  "tool": { "name": "meshify", "version": "0.1.0", "tier": "ts-wasm" },
  "command": "inspect",
  "input": { "format": "glb", "vertices": 72, "faces": 36, "meshes": [...], "bbox": [...] },
  "warnings": [],
  "exit_code": 0
}

# Simplify to 30% (ratio = fraction kept; per-submesh with materials preserved,
# submeshes <200 faces skipped with a warning)
meshify simplify model.glb --ratio 0.3

# Or an exact target face count (mutually exclusive with --ratio)
meshify simplify model.glb --target-faces 50000

# Split an assembly / cut with a plane (capped watertight by default)
meshify segment model.glb --mode connected
meshify segment model.glb --mode plane --axis x --position 0

# Web delivery: simplify + texture downscaling + meshopt/Draco compression
meshify optimize model.glb --ratio 0.5 --texture-size 2048

# STEP → GLB: routed to Tier1 automatically, with install guidance when missing
meshify convert part.step --to glb
```

Global options: `-o <path>`, `--json`, `--overwrite`, `--tier auto|ts|py`, `--preview-html`,
`--force`. Full examples and the decision tree live in [SKILL.md](skills/meshify/SKILL.md).

## Commands

| Command | Purpose | Key semantics |
|---|---|---|
| `inspect` | Read-only analysis (vertices/faces/submeshes/materials/textures/bbox) | manifest is the output; no artifact file |
| `simplify` | QEM decimation (`--ratio` fraction kept \| `--target-faces` target; one of the two) | Submeshes <200 faces skipped + `SMALL_MESH_SKIPPED` |
| `segment` | Split: `--mode plane\|connected\|semantic` | Plane cuts capped watertight by default |
| `texture` | Texturing / UV reprojection (planar/cylindrical/spherical/box/uv) | Submeshes missing UVs get box projection automatically + disclosure |
| `convert` | Format interconversion (glb/gltf/obj/stl/ply; STEP input via Tier1) | Materials/textures preserved across formats where possible, losses disclosed; empty scenes produce a valid empty file + warning |
| `lod` | Multi-level detail chain (`--levels --ratio`) | level0 kept as-is, strictly decreasing afterwards |
| `optimize` | One-command lightweighting (simplify + meshopt/draco + texture compression/downscaling) | Degrades and discloses when dependencies are missing, never fails on them |
| `doctor` | Environment check (Tier0/Tier1 readiness, uv install guidance) | `--json` for machine-readable output |

## Agent contract

Exit codes (agents decide by code):

| Code | Meaning |
|---|---|
| 0 | Success (may carry non-fatal warnings; read `warnings[]`) |
| 2 | Input unreadable (path/permissions/parse failure — truncated, corrupt, and garbage content all land here) |
| 3 | Format unsupported (export FBX etc. through a DCC first) |
| 4 | Parameter conflict / overwrite refused (overwrites need an explicit `--overwrite`; output == input is always refused) |
| 5 | Tier1 executor unavailable (stderr carries install guidance) |
| 6 | Algorithm failed on this input |
| 7 | Resource limit exceeded (>5M faces / >500 MB; `--force` for a one-shot pass) |
| 8 | Internal error |

Usage errors count as 4. Every non-zero exit (including pre-load failures 2/3/4/5) writes a
minimal failure manifest: `errors[]` with the reason, `params.failed_early: true`, input stats
zeroed as a fallback; `--json` sends it to stdout.

Each command writes `<input-name>.<op>.report.json` under `<input-name>.meshify/`, identical to
the `--json` stdout. Effects show up in `metrics.face_reduction / byte_reduction`; degradations in
`warnings[].code` — field-level documentation and the full table of 22 warning codes live in
[report-schema.md](skills/meshify/references/report-schema.md); troubleshooting in
[troubleshooting.md](skills/meshify/references/troubleshooting.md).

## Two kernels (tiering)

| Tier | Stack | Covers | Requirements |
|---|---|---|---|
| **Tier0** `ts-wasm` | TypeScript + WASM (gltf-transform / meshoptimizer / earcut) | every command on glb / gltf / obj / stl / ply | Node ≥ 18.17, zero Python |
| **Tier1** `python-uv` | Python (uv-managed; trimesh / gmsh / OpenCASCADE) | STEP/STP CAD meshing, cross-kernel cross-validation | `uv sync` (`meshify doctor` guides the install) |

Routing rules: STEP input is forced onto Tier1 (exit 5 when not installed); animated / skinned
input is forced onto Tier0 (animation preserved); everything else defaults to Tier0. `--tier
auto|ts|py` overrides, and `--tier py` runs the Python implementation with a manifest identical to
Tier0's. Details in [tiering.md](skills/meshify/references/tiering.md).

## Output layout

```
model.glb
model.meshify/
  ├─ model.inspect.report.json      # per-command reports (tool logs, auto-overwritable)
  ├─ model.simplified.glb           # single-file artifact (needs --overwrite to replace)
  ├─ model.segment-plane.glb        # merged segmentation artifact (part-level scene)
  ├─ model.lod0.glb / lod1.glb ...  # LOD chain
  └─ model.optimized.preview.html   # --preview-html self-contained comparison page
```

## Development

```bash
pnpm build                          # build core / kernel-ts / cli
pnpm test                           # full suite (Tier1 cases auto-skip without uv)
pnpm test -- tests/ts/quality.test.ts
node fixtures/generate.mjs          # regenerate golden samples (STEP part needs uv)
node fixtures/generate.mjs --big    # append a >5M-face mesh (with MESHIFY_TEST_BIG=1)
MESHIFY_TEST_BIG=1 pnpm test        # include resource-guard (exit 7) cases
```

Quality assertions are kernel-independent (custom Hausdorff sampling / boundary-edge
watertightness counting). Cross-kernel consistency tests require the same input to yield
identical vertices, faces, materials, textures, per-submesh statistics, and bbox on Tier0 and
Tier1.

CI ([ci.yml](.github/workflows/ci.yml)): a Tier0 matrix of win/mac/linux × Node 18/20/22, a
three-platform uv full-chain Tier1 job, and a manually triggered big-mesh guard job.

> Note: `pnpm.overrides` in the root `package.json` pins sharp for ndarray-pixels at 0.33.5 —
> the prebuilt linux/macOS libvips of the sharp 0.35 line lacks OpenJPEG and crashes at module
> load ([sharp#4475](https://github.com/lovell/sharp/issues/4475)). Confirm the upstream fix
> before upgrading.

<details>
<summary>Repository layout</summary>

```
packages/core          contract layer: zod schema / warning codes / exit codes / tier routing / Python bridge
packages/kernel-ts     Tier0 kernel: io/inspect/simplify/segment/texture/convert/lod/optimize
packages/cli           commander CLI: 8 commands + output management + before/after preview HTML
packages-py/kernel-py  Tier1 kernel: trimesh/gmsh service layer (uv run python -m meshify_kernel payload.json)
skills/meshify         the agent skill: SKILL.md + references/ + installers
tests/ts               contract (zod×ajv) / quality (Hausdorff, watertightness) / per-command / exit codes / cross-kernel consistency / e2e
fixtures               golden sample generator + committed artifacts (multi-material / open shells / STL / STEP / skinned animation / empty geometry)
```

</details>

## Documentation

- [SKILL.md](skills/meshify/SKILL.md) — skill overview and decision tree
- [references/](skills/meshify/references/) — per-command detail, report schema, tier routing, troubleshooting
- [report-schema.md](skills/meshify/references/report-schema.md) — `meshify.report/v1` field-level docs and the 22 warning codes
- Chinese translations: [README.zh-CN.md](README.zh-CN.md) / [SKILL.zh-CN.md](skills/meshify/SKILL.zh-CN.md) / [references/zh-CN/](skills/meshify/references/zh-CN/)

## Contributing

Issues and PRs are welcome. Keep `pnpm build && pnpm test` green; changes touching contracts
(exit codes / warning codes / manifest schema) should update [references/](skills/meshify/references/)
and the tests together.

## License

[MIT](LICENSE) © 2026 Leo Xie
