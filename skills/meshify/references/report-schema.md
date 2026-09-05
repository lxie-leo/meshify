# report-schema — meshify.report/v1 field reference

> English | [简体中文](zh-CN/report-schema.md)

Authoritative definitions: `packages/core/src/schema.ts` (zod, runtime validation) and the JSON
Schema it exports (draft-07, cross-checked by ajv). This document is a reading-oriented summary;
the two schema definitions are kept identical by contract tests.

## Top level

| Field | Type | Notes |
|---|---|---|
| `schema` | `"meshify.report/v1"` | contract version |
| `tool` | `{name, version, tier}` | `tier`: `ts-wasm` \| `python-uv` |
| `command` | string | inspect/simplify/segment/texture/convert/lod/optimize |
| `input` | InputInfo | input-side statistics |
| `output` | OutputInfo \| null | null for inspect |
| `params` | object | command parameters echoed as the CLI assembled them (not the user's raw strings) |
| `metrics` | Metrics | reduction/error/parts/LOD/duration |
| `warnings` | Warning[] | explicit degradation disclosures (code table in troubleshooting.md) |
| `errors` | string[] | non-empty means failure |
| `exit_code` | int | matches the process exit code |

## InputInfo

`path` `format` `bytes` `vertices` `faces` `meshes[]` `materials` `textures[]` `bbox` `has_animation`

- `meshes[]`: `{name, vertices, faces, material(null|string), has_uv, has_normals, skipped?}`
- `textures[]`: `{uri, mime(null), bytes, resolution(null|"WxH")}`
- `bbox`: `[[minX,minY,minZ],[maxX,maxY,maxZ]]` or null (empty geometry)
- `has_animation`: has animations/skins (always false on the Tier1 route — intercepted by routing)

## OutputInfo

`path` `format` `bytes` `vertices` `faces` `files[]`

- `bytes`: size of the main artifact file (sum of part bytes for multi-part commands)
- `files[]`: `{path, bytes, role}`, role ∈ `asset|preview|report|part|lod`
  — the single source of artifact paths for the agent

## Metrics

| Field | Appears in | Notes |
|---|---|---|
| `duration_ms` | all | duration (always present) |
| `face_reduction` | commands that output faces | 1 - out_faces/in_faces (mathematical definition, **can be negative**: the output may have more faces than the input, e.g. geometry produced from a 0-face empty input, or faces introduced by capping/merging; judge by the sign, not the magnitude) |
| `byte_reduction` | same as above | 1 - out_bytes/in_bytes (can be negative after binding textures) |
| `ratio_actual` | simplify | fraction of faces actually kept (affected by min-faces skips) |
| `max_error_normalized` | Tier0 simplify | normalized geometric error upper bound (meshopt error semantics) |
| `parts[]` | segment | `{index, path, vertices, faces}` per part |
| `lod_levels[]` | lod | `{level, path, faces, vertices, bytes, ratio}` per level |
| `derives_from` | derived artifacts | source file path |
| `tier_note` | all | routing/execution note for this run (free text) |

## How to consume it (agent)

1. `exit_code !== 0` → act by code (the action table in troubleshooting.md)
2. `errors[]` non-empty → read it even when exit is 0 (partial-success scenarios carry details there at exit 7)
3. Verify effect via `metrics.face_reduction/byte_reduction`; quality doubts → `max_error_normalized`
4. Take artifact paths from `output.files[]` (don't assemble paths yourself)
5. When `warnings` contains `MATERIAL_DEGRADED_TO_BASE_COLOR`/`TIER_DOWNGRADED`, explain the
   degradation and the way around it to the user (see the matching references doc)

## Failures also produce a manifest (minimal early-failure report)

On the TS side, when a command fails early via MeshifyError (unreadable input, parameter
conflict, same-format guard, empty scene, ...), a minimal manifest is written before the rethrow:
`output: null`, `params: {failed_early: true}`, `errors: [reason]`, `exit_code` matching the
process exit code; when the input structure is unknown, `input.vertices/faces` are zeroed as a
fallback (not real statistics). Under `--json`, stdout still carries the full JSON — **the stdout
manifest contract is identical on success and failure paths**; the agent always "parses stdout
first, and on failure reads errors[] + exit_code". The Tier1 failure manifest is assembled by the
Python runner (richer information, input stats measured), and the TS bridge forwards it verbatim.
