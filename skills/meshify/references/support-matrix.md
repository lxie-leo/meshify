# support-matrix — support matrix and host compatibility

> English | [简体中文](zh-CN/support-matrix.md)

## Format × command

| Input format | inspect | simplify | segment | texture | convert | lod | optimize |
|---|---|---|---|---|---|---|---|
| glb | T0 | T0 | T0/T1 | T0/T1 | T0/T1 | T0/T1 | T0 (T1: no compression) |
| gltf | T0 | T0 | T0/T1 | T0/T1 | T0/T1 | T0/T1 | T0 |
| obj | T0 | T0 | T0/T1 | T0/T1 | T0/T1 | T0/T1 | T0 |
| stl | T0 | T0 | T0/T1 | T0/T1 | T0/T1 | T0/T1 | T0 |
| ply | T0 | T0 | T0/T1 | T0/T1 | T0/T1 | T0/T1 | T0 |
| step/stp | T1 | T1 | T1 | T1 | T1 | T1 | T1 |
| fbx/other | exit 3 | exit 3 | exit 3 | exit 3 | exit 3 | exit 3 | exit 3 |

T0 = Tier0 default; T1 = explicit `--tier py` option; step/stp = Tier1 only.
Default (auto) routing: animated input → T0; STEP → T1; everything else → T0.

## Known boundaries

- **FBX/3DS/DAE** are not supported (neither trimesh nor gltf-transform reads them) — export GLB
  from your DCC first
- **glTF extensions**: reading registers all Khronos extensions (KHR_materials_* / draco / meshopt
  etc.); writing produces core + EXT_meshopt_compression; unknown custom extensions may be dropped
  during conversion
- **OBJ vertex normals (vn)**: Tier1 inspect conservatively reports has_normals=false (trimesh
  renormalizes and the origin can't be distinguished); Tier0 reports exactly what the file declares
- **Texture formats**: glTF core only bakes in PNG/JPEG; webp and other inputs are converted to
  PNG automatically (`TEXTURE_FORMAT_CONVERTED`)
- **Large models**: inputs >500 MB or >5M faces trip the resource guard (exit 7); use `--force`
  for a one-shot run, or split the model first

## Agent hosts

The CLI is the only interface (stdin/stdout + exit codes); no host APIs are used:

| Host | Install location | Verification |
|---|---|---|
| Claude Code | `.claude/skills/meshify/` | inspect → simplify → read report E2E |
| Cursor | `.cursor/skills/meshify/` | same |
| Codex CLI | `.agents/skills/meshify/` | same |
| Tongyi Lingma / Qoder | host-specific skills directory | same |
| CodeBuddy | host-specific skills directory | same |
| Baidu Comate | host-specific skills directory | same |

The installer `scripts/install.sh` / `install.ps1` auto-detects host directories and copies
SKILL.md + references/. The CLI itself runs via `npx` (once published to npm) or
`node packages/cli/bin/meshify.js` from this repository.

## Runtime environment

- Node ≥ 18.17 (Tier0 baseline; CI matrix 18/20/22)
- Windows / macOS / Linux (path handling covers win32 backslashes and drive letters)
- Tier1: uv + Python ≥ 3.12; about 200 MB of disk (.venv)
