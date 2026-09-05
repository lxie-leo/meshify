> [English](../support-matrix.md) | 简体中文

# support-matrix —— 支持矩阵与宿主兼容

## 格式 × 命令

| 输入格式 | inspect | simplify | segment | texture | convert | lod | optimize |
|---|---|---|---|---|---|---|---|
| glb | T0 | T0 | T0/T1 | T0/T1 | T0/T1 | T0/T1 | T0（T1 无压缩） |
| gltf | T0 | T0 | T0/T1 | T0/T1 | T0/T1 | T0/T1 | T0 |
| obj | T0 | T0 | T0/T1 | T0/T1 | T0/T1 | T0/T1 | T0 |
| stl | T0 | T0 | T0/T1 | T0/T1 | T0/T1 | T0/T1 | T0 |
| ply | T0 | T0 | T0/T1 | T0/T1 | T0/T1 | T0/T1 | T0 |
| step/stp | T1 | T1 | T1 | T1 | T1 | T1 | T1 |
| fbx/其他 | exit 3 | exit 3 | exit 3 | exit 3 | exit 3 | exit 3 | exit 3 |

T0 = Tier0 默认；T1 = `--tier py` 显式可选；T1（必需）= 仅 Tier1。
默认（auto）路由：动画输入→T0；STEP→T1；其余→T0。

## 已知边界

- **FBX/3DS/DAE** 不支持（trimesh 与 gltf-transform 均不读）——在 DCC 里先导 GLB
- **glTF 扩展**：读侧注册全部 Khronos 扩展（KHR_materials_* / draco / meshopt 等），
  写侧产物使用核心 + EXT_meshopt_compression；未知自定义扩展在转换中可能丢弃
- **OBJ 顶点法线（vn）**：Tier1 inspect 保守上报 has_normals=false（trimesh 归一化重算，
  无法区分来源）；Tier0 按文件声明精确上报
- **贴图格式**：glTF 核心只内建 PNG/JPEG；webp 等输入自动转 PNG（`TEXTURE_FORMAT_CONVERTED`）
- **大模型**：输入 >500MB 或 >500 万面触发资源防护（exit 7），`--force` 一次性处理或先拆件

## Agent 宿主

CLI 是唯一接口（stdin/stdout + 退出码），不依赖任何宿主 API：

| 宿主 | 安装位置 | 验证 |
|---|---|---|
| Claude Code | `.claude/skills/meshify/` | inspect → simplify → 读报告 E2E |
| Cursor | `.cursor/skills/meshify/` | 同上 |
| Codex CLI | `.agents/skills/meshify/` | 同上 |
| 通义灵码 / Qoder | 宿主自定义 skills 目录 | 同上 |
| CodeBuddy | 宿主自定义 skills 目录 | 同上 |
| 文心快码 | 宿主自定义 skills 目录 | 同上 |

安装器 `scripts/install.sh` / `install.ps1` 自动探测宿主目录并复制 SKILL.md + references/。
CLI 本体通过 `npx`（npm 发布后）或仓库内 `node packages/cli/bin/meshify.js` 使用。

## 运行环境

- Node ≥ 18.17（Tier0 基线；CI 矩阵 18/20/22）
- Windows / macOS / Linux（路径处理已覆盖 win32 反斜杠与盘符）
- Tier1：uv + Python ≥ 3.12；磁盘 ~200MB（.venv）
