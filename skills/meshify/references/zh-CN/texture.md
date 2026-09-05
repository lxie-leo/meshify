> [English](../texture.md) | 简体中文

# texture —— 五投影 UV + 贴图绑定

## 语法

```
meshify texture <input> --map <mode> [--image tex.png] [--metallic 0] [--roughness 0.8]
```

| `--map` | 投影 | 适用 |
|---|---|---|
| `uv` | 保留现有 UV | 输入已有正确 UV |
| `planar` | XZ 平面俯视投影 | 平板/浮雕类 |
| `cylindrical` | 柱面展开（Y 轴） | 杯子/管道；帽面自动改平面投影 |
| `spherical` | 球面展开 | 球/近似球；帽面同上 |
| `box` | 六朝向三平面，每面铺满 | 方块件/文字图表贴图（无 UV 时的自动回退） |

## 行为

- `--map uv` 但模型无 UV → 自动盒式投影 + `AUTO_BOX_UV_GENERATED`
- UV 是合并产生的色块图集（≤64px 贴图特征）→ 忽略并盒式回退 + `ATLAS_UV_IGNORED`（坑 2）
- `--image`：绑定 baseColor 贴图；非 PNG/JPEG（webp/tiff/bmp/gif）自动规范化转 PNG +
  `TEXTURE_FORMAT_CONVERTED`（glTF 核心规范只内建 PNG/JPEG 两种位图）
- `--map uv` 与 `--image` 互斥（保留旧 UV 无法保证贴图正确映射）——exit 4
- `--metallic/--roughness`：覆盖所有材质的 PBR 标量
- STL 等无材质输入：自动补默认材质保证贴图有落点

## Tier1 特有防护

- 柱/球接缝：跨缝三角形 u 跨度 >0.5 时分裂接缝顶点（u-1），消除整图扫描拉花带
- 帽面（近水平面）柱/球投影退化 → 改 XZ 平面投影铺满

## 产物

`<输入名>.meshify/<输入名>.textured.glb` + 报告。

## 报告要点

`warnings` 会列出全部近似决策（AUTO_BOX_UV_GENERATED / ATLAS_UV_IGNORED / TEXTURE_FORMAT_CONVERTED）。
贴图后体积可能增大（纹理由外置变内嵌）——`byte_reduction` 为负是正常的。
