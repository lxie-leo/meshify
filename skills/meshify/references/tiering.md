# tiering —— 双内核仲裁

## 为什么两层

| | Tier0（ts-wasm） | Tier1（python-uv） |
|---|---|---|
| 运行时 | Node ≥ 18.17，零额外安装 | Python ≥ 3.12（uv 管理） |
| 几何 | gltf-transform + meshoptimizer WASM + earcut + sharp | trimesh + pyfqmr + sklearn + gmsh(OCC) |
| 独有能力 | meshopt/draco 压缩、WebP 贴图、动画/蒙皮结构保留 | **STEP/STP CAD 读取**、跨子网格焊接拆实体 |
| 启动 | ~0.1s | 冷启动 ~2s（uv run） |

## 仲裁规则（tier-orchestrator，硬规则）

1. **动画/蒙皮/morph 输入 → 强制 Tier0**
   trimesh 管线加载即丢动画（maestro 勘察实证）。检测到 animations/skins 时路由层直接改走
   Tier0 并写 `SKIN_ANIMATION_PRESERVED`。`--tier py` 也拦。
2. **STEP 输入 → 强制 Tier1**
   Tier0 无解析能力。Tier1 未就绪 → exit 5 + 安装指引。**没有降级路径，这是能力边界不是故障。**
3. 其余命令默认 Tier0；`--tier py` 显式要求走 Tier1（不可用则 exit 5）。
4. 环境探测缓存 24h（`~/.meshify/tier-env.json`）；`meshify doctor --refresh` 强制重探。

## manifest 里的痕迹

- `tool.tier`：`ts-wasm` 或 `python-uv`
- `metrics.tier_note`：本次路由说明（如「connected: 3 连通域，输出 3 部件」）
- 降级/保留动画 → 对应警告码（`TIER_DOWNGRADED` / `SKIN_ANIMATION_PRESERVED`）

## 跨内核一致性

两内核对同一输入的 `inspect` 统计（顶点/面数/子网格/材质数/包围盒）以文件声明为准，
数值一致（tests 有一致性用例守护）。简化/分割的具体几何结果**不保证逐顶点一致**
（不同 QEM 实现），但都满足各自的质量红线（面数比例、水密性、材质保留）。

## Tier1 输出差异（如实披露）

- segment/lod 多部件走 `output_dir/part_000.glb…`（Tier0 是单 GLB 多节点或独立 lodN 文件）
- optimize 无几何压缩（`TIER_DOWNGRADED`）
- 部件文件覆盖约定两侧一致：存在即拒（exit 4），`--overwrite` 才覆盖
