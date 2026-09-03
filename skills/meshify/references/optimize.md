# optimize —— Web 交付一键优化

## 语法

```
meshify optimize <input> [--ratio 0.5] [--error 0.01] [--compression meshopt]
                  [--texture-format webp] [--texture-size 2048] [--min-faces 200]
```

| 参数 | 默认 | 说明 |
|---|---|---|
| `--ratio <n>` | 不简化 | 传入才做简化（与 simplify 同参数语义） |
| `--error <n>` | 0.01 | 简化误差上限 |
| `--compression` | meshopt | `meshopt` / `draco` / `none`。draco 需可选依赖，缺失时跳过并 `DRACO_UNAVAILABLE` |
| `--texture-format` | webp | `webp` / `jpeg` / `png` / `none`（不动贴图）。glTF 核心 GPU 上限 2048 的兼容性最好 |
| `--texture-size <n>` | 不限 | 贴图最长边上限，超出降采样（坑 11：降采样必须披露 `TEXTURE_DOWNSCALED`） |
| `--min-faces <n>` | 200 | 简化跳过阈值 |

## 管线顺序（Tier0）

```
去重(weld) → 修剪(prune) → [可选简化] → [贴图压缩/降采样] → meshopt|draco 几何压缩
```

顺序遵循 gltf-transform 规范：weld 先行（合并索引提高压缩率），prune 收尾清孤立资源。

## Tier1（--tier py）边界

meshopt/draco 是 WASM 编码器（Tier0 专属）。Tier1 路线输出**未压缩基线**并写
`TIER_DOWNGRADED` 披露——需要压缩时别加 `--tier py`。

## 产物

`<输入名>.meshify/<输入名>.optimized.glb`；`--preview-html` 附对比页。

## 报告要点

```jsonc
"metrics": { "face_reduction": 0.5, "byte_reduction": 0.82 }
```

体积削减主要来自贴图（WebP + 降采样）；几何 meshopt 通常再省 30–60% 顶点buffer。

## 预览页（--preview-html）

自包含单文件 HTML（GLB base64 内嵌，three.js 走 CDN）：
双视窗联动旋转、缺 NORMAL 网格自动 flatShading（坑 10）、按贴图亮度调环境光防过曝（坑 11）、
右下角 manifest 指标面板。给用户看效果/自查降级直接开这个文件。
