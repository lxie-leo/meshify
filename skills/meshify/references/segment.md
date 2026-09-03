# segment —— 三模式分割

## 语法

```
meshify segment <input> --mode <connected|plane|semantic> [选项]
```

### connected（连通域拆件——装配体首选）

```
meshify segment model.glb --mode connected [--min-faces 1]
```

共享边连通域；Tier1 会先跨子网格按位置焊接再拆「实体」（CAD 颜色分组的断壳重新缝合）。
`--min-faces <n>`：小于该面数的碎片部件丢弃（`SMALL_PARTS_DROPPED`；全部会被丢时保留最大者）。

### plane（平面切割）

```
meshify segment model.glb --mode plane --axis x --position 0       # 滑块语义
meshify segment model.glb --mode plane --origin "0,10,0" --normal "0,1,0"   # 原生坐标
```

- `--axis x|y|z` + `--position ∈ [-1,1]`：线性映射包围盒两端（-1 = min，0 = 中点，+1 = max）
- `--origin` + `--normal`：任意平面（两参数必须成对；与 axis 互斥）
- `--no-cap`：关闭截面封口（默认开启 earcut 封口保水密，切片/3D 打印场景务必保持默认）
- **坑 5/6 防护**：封口零面积碎片三角形原样保留（`FRAGMENT_FACES_KEPT`，渲染不可见，删了会开洞）

### semantic（法线+位置聚类）

```
meshify segment model.glb --mode semantic [--clusters 8]
```

**边界（如实披露）**：semantic 认的是「朝向+位置」不是零件语义。平面/曲面/朝向分区有效；
装配体拆成独立零件请用 connected。

## 产物

- Tier0：单 GLB `<输入名>.segment-<mode>.glb`（每部件一个节点；semantic 附黄金角部件着色）
- Tier1：目录 `<输入名>.segment-<mode>/part_000.glb …`（manifest.parts 逐件披露路径/面数）

## 报告要点

```jsonc
"metrics": {
  "parts": [ { "index": 0, "path": "part_000.glb", "vertices": 23890, "faces": 47772 } ],
  "tier_note": "plane: 2 部件（截面 earcut 封口）"
}
```

## 防护（内嵌的 maestro 实坑）

| 坑 | 默认行为 | 警告码 |
|---|---|---|
| 坑 3 开口壳背面剔除 | 分割件材质强制 doubleSided | `DOUBLE_SIDED_FORCED` |
| 坑 5 切口烂面锯齿 | earcut 封口保水密 | （封口失败时 `NON_MANIFOLD_INPUT`） |
| 坑 6 碎片三角形 | 零面积面保留不开洞 | `FRAGMENT_FACES_KEPT` |
| 坑 4 CAD 断壳 | Tier1 跨子网格焊接后拆实体 | — |
