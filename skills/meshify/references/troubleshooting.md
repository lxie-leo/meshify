# troubleshooting — exit codes and full warning-code table

> English | [简体中文](zh-CN/troubleshooting.md)

## Exit code → action

| Code | Meaning | Agent's next step |
|---|---|---|
| 0 | Success | Read the manifest (warnings included) |
| 2 | Input unreadable | Check path/permissions; verify with `meshify inspect` |
| 3 | Format unsupported | Export FBX etc. to GLB in a DCC first |
| 4 | Parameter conflict / overwrite refused | Fix parameters per the message; add `--overwrite` to confirm |
| 5 | Tier1 unavailable | `meshify doctor --install-uv` → `uv sync` (cad-step.md) |
| 6 | Algorithm failure | Adjust plane position/cluster count; or connected-split first and work in batches. Empty scenes (0 faces) also use this code |
| 7 | Resource limit / partial success | `--force` once, or split |
| 8 | Internal error | Attach report.json to the bug report |

## Full warning-code table (warnings are not failures)

| Code | Context | Meaning |
|---|---|---|
| `SMALL_MESH_SKIPPED` | simplify/lod | Submesh < min-faces, skipped and kept as-is (pitfall 12) |
| `MATERIAL_DEGRADED_TO_BASE_COLOR` | Tier1 simplify/segment | UVs could not be remapped; material degraded to baseColor scalar only (textures stripped) |
| `UV_REMAP_APPROXIMATED` | Tier1 geometry rebuild | UVs of collapsed/rebuilt points remapped by nearest-face barycentric interpolation (approximate) |
| `NON_MANIFOLD_INPUT` | plane cut | Input looks like coincident shells / non-manifold; the cross-section could not be capped watertight |
| `FRAGMENT_FACES_KEPT` | plane capping | Zero-area fragment triangles kept (removing them opens holes, pitfall 6) |
| `DOUBLE_SIDED_FORCED` | segment/texture artifacts | Materials forced double-sided (open shells vs. backface culling, pitfall 3) |
| `TEXTURE_DOWNSCALED` | optimize | Texture downsampled (exceeded `--texture-size`, pitfall 11) |
| `TEXTURE_FORMAT_CONVERTED` | optimize/texture | Non-PNG/JPEG texture normalized to PNG (glTF core only bakes in these two bitmap formats) |
| `TIER_DOWNGRADED` | tier routing | Tier1 unavailable, degraded to Tier0 execution (STEP excepted — it exits 5 directly) |
| `SKIN_ANIMATION_PRESERVED` | tier routing | Animated input forced onto Tier0 to preserve animation |
| `ATLAS_UV_IGNORED` | texture --map uv | Color-block atlas UVs ignored, box fallback (pitfall 2) |
| `AUTO_BOX_UV_GENERATED` | texture --map uv | No UVs present, box projection generated automatically |
| `PARTIAL_SUCCESS` | multi-submesh processing | Some submeshes failed ( accompanies exit 7) |
| `MATERIALS_MERGED` | OBJ→GLB / simplify --merge | Equivalent materials / same-material submeshes merged automatically (related to pitfall 1) |
| `MERGE_INCOMPATIBLE_FALLBACK` | simplify --merge | Same-material submeshes have incompatible vertex attributes and cannot merge; fell back to per-submesh (geometry/materials unaffected) |
| `INDEX_OUT_OF_RANGE` | OBJ input | Face references an out-of-range index (nonexistent vertex/UV/normal); out-of-range components filled with defaults |
| `SMALL_PARTS_DROPPED` | segment connected | Fragment parts dropped (if all would drop, the largest is kept) |
| `DRACO_UNAVAILABLE` | optimize draco | draco3dgltf optional dependency missing; geometry compression skipped |
| `EMPTY_SCENE_OUTPUT` | convert | Input is an empty scene (0 faces); the output is a valid empty file of the same format (structural operations don't block this) |
| `FORMAT_CONTENT_MISMATCH` | OBJ input | Extension doesn't match binary content (e.g. an STL renamed .obj); processed by extension, but parse results are suspect |
| `ORPHAN_GEOMETRY_ATTACHED` | convert/lod (Tier1) | Input contained orphan geometry not mounted in the scene graph (non-default scenes of a multi-scene GLB); explicitly attached to prevent loss on export |
| `PREVIEW_BEFORE_UNAVAILABLE` | Tier1 `--preview-html` | Original input is not glb/gltf (e.g. STEP) and can't render in a browser; the preview page shows the artifact side only (single viewport); non-GLB artifacts skip the page entirely |
| `UP_AXIS_NORMALIZED` | Tier1 geometry commands (STEP input) | STEP coordinates treated as Z-up per CAD convention; output rotated to the glTF-required Y-up (shape unchanged, orientation normalized only). If the part was authored lying down (real up axis not Z), pass `--up-axis x\|-y` etc. at convert time to upright it |
| `UP_AXIS_AUTO` | convert `--up-axis auto` | High-confidence auto-detection succeeded: discloses the detected up axis and its geometric evidence (mounting-hole cluster position/count); `params.up_axis_resolved` is the machine-readable verdict. Low confidence (symmetric parts / no holes) → exit 4 with candidates listed |

## Common failures

**Preview page is blank**: three.js CDN unreachable (the page falls back jsdelivr→unpkg and shows
an error layer when both fail) — reconnect and reopen.

**Tier1 deep-import check FAILs**: run `cd packages-py/kernel-py && uv sync`, then `meshify doctor`
again (doctor re-probes live every time).

**Face count didn't drop after simplify**: everything is small submeshes under min-faces (check
warnings); lower `--min-faces` or double-check the input.

**Plane cut exits 6 "does not intersect the model"**: `--position` outside [-1,1], or the plane
grazes the bbox surface; use inspect's bbox to compute native coordinates and go with
`--origin/--normal`.

**Garbled CJK output on Windows**: CLI output is UTF-8; old terminals (cmd defaults to GBK) need
`chcp 65001` first.

**Re-running reports "output already exists"**: not overwriting by default is the feature
(idempotent and safe); add `--overwrite` to confirm, or pick another `-o` path.

**Wanting the manifest even on non-zero exits**: early failures (unreadable input, parameter
conflict, ...) also write a minimal manifest (`params.failed_early=true`, `errors[]` carries the
reason, `input.vertices/faces` zeroed as a fallback) — `--json` outputs it to stdout as usual.

## Performance reference

- Tier0 warm start < 0.5s; 1M-face simplify ~10s (WASM multi-threading varies by platform)
- Tier1 cold start ~2s (uv run); STEP meshing scales with model complexity (~5s at the 100k-face level)
- Preview page generation < 0.5s (large GLBs embedded as base64 inflate the HTML; expected)
