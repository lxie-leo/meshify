> [English](../simplify.md) | 简体中文

# simplify —— QEM 减面

## 语法

```
meshify simplify <input> [--ratio 0.5] [--target-faces N] [--error 0.01]
                  [--min-faces 200] [--aggressiveness 7] [--no-keep-border] [--merge]
```

| 参数 | 默认 | 说明 |
|---|---|---|
| `--ratio <n>` | 0.5 | 保留面数比例 (0.01–1]。与 `--target-faces` 二选一 |
| `--target-faces <n>` | — | 精确目标面数（各子网格按比例分摊）。与 `--ratio` **互斥**，同时给出报 exit 4 |
| `--error <n>` | 0.01 | 误差上限（归一化 0–1），简化误差超过此值的面保留 |
| `--min-faces <n>` | 200 | 小于该面数的子网格跳过简化（外观退化风险大于收益），写 `SMALL_MESH_SKIPPED` |
| `--aggressiveness <n>` | 7 | QEM 激进程度 1–10，越大越保守（Tier1 pyfqmr 语义） |
| `--no-keep-border` | 开 | 关闭边界保留（开口壳边界可能被折叠掏空——一般别关） |
| `--merge` | 关 | 跨子网格合并简化（丢子网格边界，材质按多数保留） |

## 行为

- **逐子网格处理（坑 1 防护）**：多材质模型各子网格独立简化、材质原样保留，绝不合并成白模
- **Tier0**（meshoptimizer WASM）：`--error` 生效，manifest 带 `max_error_normalized`；
  被简化的贴图网格写 `UV_REMAP_APPROXIMATED` 警告（塌缩区贴图从保留顶点子集采样）
- **Tier1**（pyfqmr）：`--aggressiveness` 生效；贴图网格不按位置焊接（保接缝双顶点），
  塌缩点 UV 按最近三角面重心插值重映射（同 `UV_REMAP_APPROXIMATED` 码）
- **UV 接缝造成的面数下限（双内核）**：带 UV 子网格的深度减面被 UV 岛接缝顶住——接缝顶点在索引空间
  被切开，等效于减面器无法跨坍缩的锁定边界，`--no-keep-border`/`--merge` 均绕不开。
  带 UV 子网格实际面数远超请求目标时写 `UV_SEAM_DECIMATION_LIMITED` 警告；要压更低请先减面后贴图
- 动画/蒙皮输入强制 Tier0（`SKIN_ANIMATION_PRESERVED`）

## 产物

`<输入名>.meshify/<输入名>.simplified.glb` + 同名 `.report.json`。

## 报告要点

```jsonc
"metrics": { "face_reduction": 0.7, "ratio_actual": 0.3, "max_error_normalized": 0.004 }
```

`ratio_actual` 是实际保留比（受 min-faces 跳过或 UV 接缝下限影响可能高于请求值——后者见
`UV_SEAM_DECIMATION_LIMITED`）。

## 建议

- Web 展示：`--ratio 0.3 --error 0.01` 起步，看 `max_error_normalized` 不超过 0.01 再加码
- **顺序铁律：先减面后贴图。** 投影生成的 UV 岛会把接缝顶点切进网格，等效于后续深度减面
  的锁定边界——先贴图会封死后续的减面下限。模型尚无 UV 时，先 simplify 再 texture
- 模型整体面数 < 1000 时别简化（收益小、退化明显；min-faces 会替你挡大部分）
- 要更狠的减面 + 体积压缩：直接用 `optimize`（简化 + meshopt 一条管线）
