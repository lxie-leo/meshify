# convert — format conversion

> English | [简体中文](zh-CN/convert.md)

## Syntax

```
meshify convert <input> --to <glb|gltf|obj|stl|ply>
```

`--to` defaults to `glb` (the most universal single-file form). Same-format conversion is refused
(exit 4) — re-encode by way of an intermediate format. With `-o`, the explicit output path's
extension must match `--to` (otherwise exit 4; this prevents STL bytes landing in a file named .glb).

## Routes

- **Tier0** (glb/gltf/obj/stl/ply input): read, rebuild as a glTF Document, export
  - OBJ input: the matching `.mtl` and referenced textures are picked up automatically; materials become PBR
  - glTF output: the external `.bin` and textures land next to the artifact (manifest.files lists
    every file; move them together)
  - OBJ output: main file + `.mtl` + textures (manifest.files lists every file)
- **Tier1** (step/stp input, or `--tier py`): STEP → OCC meshing → color grouping → target format
  (details in cad-step.md)

## Fidelity and disclosure

- Zero material loss is a hard constraint (pitfall 1); merging equivalent materials on OBJ→GLB writes `MATERIALS_MERGED`
- STL/PLY have no material semantics: converting them to GLB yields geometry only (use the texture command for textures)
- Animation/skinning is structurally preserved on the Tier0 route; `--tier py` drops it (trimesh
  pipeline; the routing layer intercepts this beforehand)
- obj/stl/ply output stats are verified by reading the file back (`metrics` reflect the actual
  file, not in-memory estimates)

## Output

`<input-name>.meshify/<input-name>.converted-<to>.<ext>` (OBJ adds sidecar files).

## Common combinations

```bash
meshify convert model.obj --to glb            # OBJ (mtl + textures) packed into one file
meshify convert part.step --to glb            # CAD → web (needs Tier1)
meshify convert model.glb --to stl            # hand off to a slicer
meshify convert model.glb --to gltf           # text format for troubleshooting
```
