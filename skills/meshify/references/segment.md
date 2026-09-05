# segment — three split modes

> English | [简体中文](zh-CN/segment.md)

## Syntax

```
meshify segment <input> --mode <connected|plane|semantic> [options]
```

### connected (connected components — first choice for assemblies)

```
meshify segment model.glb --mode connected [--min-faces 1]
```

Components connected through shared edges. Tier1 first welds across submeshes by position, then
splits into "solids" (re-stitching the broken shells that CAD color grouping produces).
`--min-faces <n>`: fragment parts below this face count are dropped (`SMALL_PARTS_DROPPED`; if all
parts would be dropped, the largest one is kept).

### plane (plane cut)

```
meshify segment model.glb --mode plane --axis x --position 0       # slider semantics
meshify segment model.glb --mode plane --origin "0,10,0" --normal "0,1,0"   # native coordinates
```

- `--axis x|y|z` + `--position ∈ [-1,1]`: linear mapping across the bounding box (-1 = min, 0 = midpoint, +1 = max)
- `--origin` + `--normal`: arbitrary plane (the two must be given together; mutually exclusive with axis)
- `--no-cap`: disables cut-face capping (on by default: earcut capping keeps parts watertight; keep
  the default for slicing and 3D-printing workflows)
- **Pitfall 5/6 guards**: zero-area fragment triangles produced by capping are kept as-is
  (`FRAGMENT_FACES_KEPT`); they are invisible when rendered, and removing them opens holes

### semantic (normal + position clustering)

```
meshify segment model.glb --mode semantic [--clusters 8]
```

**Boundary**: semantic clusters by orientation + position, not by part identity. It works for
partitioning flat/curved/differently oriented regions; to split an assembly into individual parts,
use connected.

## Output

- Tier0: a single GLB `<input-name>.segment-<mode>.glb` (one node per part; semantic adds golden-angle part coloring)
- Tier1: directory `<input-name>.segment-<mode>/part_000.glb …` (manifest.parts discloses path/face count per part)

## Report highlights

```jsonc
"metrics": {
  "parts": [ { "index": 0, "path": "part_000.glb", "vertices": 23890, "faces": 47772 } ],
  "tier_note": "plane: 2 parts (cut faces capped with earcut)"
}
```

## Built-in guards (from real-world pitfalls)

| Pitfall | Default behavior | Warning code |
|---|---|---|
| 3: backface culling on open shells | Split parts get doubleSided materials forced | `DOUBLE_SIDED_FORCED` |
| 5: jagged broken faces at the cut | earcut capping keeps parts watertight | (`NON_MANIFOLD_INPUT` when capping fails) |
| 6: fragment triangles | Zero-area faces kept, no holes opened | `FRAGMENT_FACES_KEPT` |
| 4: CAD broken shells | Tier1 welds across submeshes, then splits solids | — |
