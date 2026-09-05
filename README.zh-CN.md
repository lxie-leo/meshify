> [English](README.md) | 简体中文

# Meshify

> 三维模型轻量化 CLI：减面、拆件、贴图、格式转换、LOD、Web 交付优化，一条 `meshify` 命令完成。输出 `meshify.report/v1` 结构化报告与语义化退出码，供 Agent 直接消费。

[![CI](https://github.com/lxie-leo/meshify/actions/workflows/ci.yml/badge.svg)](https://github.com/lxie-leo/meshify/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-informational.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A518.17-339933?logo=node.js&logoColor=white)](packages/cli/package.json)
[![Tier0](https://img.shields.io/badge/Tier0-zero--python-646CFF?logo=typescript&logoColor=white)](#-双层内核-tiering)

Meshify 把三维模型处理成 Web / AR / 移动端可交付的形态。它首先为 AI Agent（Claude Code、Cursor、Codex 等）设计：每条命令都产出结构化 manifest，自动补 UV、贴图剥离这类降级一律以警告码写进报告；同时也是一个开发者可以直接用的 CLI。

输入 `glb` / `gltf` / `obj` / `stl` / `ply` 开箱即用；`step` / `stp`（CAD）走 Tier1 内核。

## ✨ 特性

- 八个命令：`inspect` / `simplify` / `segment` / `texture` / `convert` / `lod` / `optimize` / `doctor`
- 失败也产出结构化错误报告（`errors[]` + `failed_early`），不止一个退出码
- Tier0 内核纯 Node + WASM（gltf-transform / meshoptimizer / earcut），Node ≥ 18.17 即用；STEP/STP 交给 Tier1 Python 内核（uv 管理，gmsh / OpenCASCADE），未装时报错并附安装指引
- 源文件只读；产物统一写入 `<输入名>.meshify/`；覆盖必须显式 `--overwrite`
- 质量断言独立于内核实现（自研 Hausdorff 采样 / 边界边水密性计数），双内核一致性有专门测试
- `--preview-html` 生成单文件 before/after 对比页

## 📦 安装

**从 GitHub 安装到 Agent 宿主**（推荐，无需克隆本仓库；[skills CLI](https://github.com/vercel-labs/skills)，Qoder 官方同款）：

```bash
# 自动检测本机已装的宿主，交互选择
npx skills add lxie-leo/meshify --skill meshify

# 或显式指定宿主（-g 装到用户级全局目录）
npx skills add lxie-leo/meshify --skill meshify -a claude-code   # Claude Code
npx skills add lxie-leo/meshify --skill meshify -a cursor        # Cursor
npx skills add lxie-leo/meshify --skill meshify -a codex         # Codex
npx skills add lxie-leo/meshify --skill meshify -a qoder-cn      # Qoder（国际版 -a qoder）
npx skills add lxie-leo/meshify --skill meshify -a codebuddy     # CodeBuddy
npx skills add lxie-leo/meshify --skill meshify -a universal     # Comate 等（装到 .agents/skills/，Comate 会自动加载）

npx skills update                                                # 更新已装 skill
```

Windows 下 symlink 需要开发者模式，未开启时加 `--copy` 改为复制安装。Cursor 也可走图形界面：Customize → Rules → Add Rule → Remote Rule (GitHub) → 填本仓库地址。

**Claude Code 原生插件市场**（同一路径也适用于 VSCode 扩展的 `/plugins` → Marketplaces）：

```bash
claude plugin marketplace add lxie-leo/meshify
claude plugin install meshify@meshify-skills
```

> 注意：以上远程安装装入的是 skill 文档（`SKILL.md` + `references/`）。CLI 本体目前需在本仓库内构建（见下），npm 发布后将支持 `npx meshify` 直接调用。

**已克隆仓库**（安装器构建 CLI 并复制 skill 到探测到的宿主目录）：

```bash
# PowerShell
powershell -ExecutionPolicy Bypass -File skills/meshify/scripts/install.ps1
# POSIX sh（Git Bash / macOS / Linux）
sh skills/meshify/scripts/install.sh
```

安装器复制 `SKILL.md + references/` 到宿主 skills 目录、构建 CLI（如缺失）、运行 `meshify doctor` 自检。Skill 用法见 [skills/meshify/SKILL.md](skills/meshify/SKILL.md)。

**从仓库使用**：

```bash
pnpm install && pnpm build
pnpm meshify --help
```

## 🚀 快速上手

```bash
# 先看结构：面数 / 子网格 / 材质 / 贴图 / 包围盒
$ meshify inspect fixtures/glb/multimat.glb --json
{
  "schema": "meshify.report/v1",
  "tool": { "name": "meshify", "version": "0.1.0", "tier": "ts-wasm" },
  "command": "inspect",
  "input": { "format": "glb", "vertices": 72, "faces": 36, "meshes": [...], "bbox": [...] },
  "warnings": [],
  "exit_code": 0
}

# 减面到 30%（ratio 是保留率；逐子网格保材质，<200 面跳过并警告）
meshify simplify model.glb --ratio 0.3

# 或精确目标面数（与 --ratio 互斥）
meshify simplify model.glb --target-faces 50000

# 装配体拆件 / 平面切割（默认封口保水密）
meshify segment model.glb --mode connected
meshify segment model.glb --mode plane --axis x --position 0

# Web 交付：减面 + 纹理降采样 + meshopt/Draco 压缩
meshify optimize model.glb --ratio 0.5 --texture-size 2048

# STEP → GLB：自动路由到 Tier1，未装时给安装指引
meshify convert part.step --to glb
```

通用选项：`-o <path>`、`--json`、`--overwrite`、`--tier auto|ts|py`、`--preview-html`、`--force`。全部示例与决策树见 [SKILL.md](skills/meshify/SKILL.md)。

## 🧭 命令一览

| 命令 | 作用 | 关键语义 |
|---|---|---|
| `inspect` | 只读分析（顶点/面数/子网格/材质/贴图/bbox） | manifest 即输出，无产物文件 |
| `simplify` | QEM 减面（`--ratio` 保留率 \| `--target-faces` 目标面数，二选一） | 小网格 <200 面跳过 + `SMALL_MESH_SKIPPED` |
| `segment` | 拆件：`--mode plane\|connected\|semantic` | 平面切割默认封口保水密 |
| `texture` | 贴图 / UV 重投影（planar/cylindrical/spherical/box/uv） | 缺 UV 子网格自动补盒式 + 警告披露 |
| `convert` | 格式互转（glb/gltf/obj/stl/ply；STEP 读入走 Tier1） | 材质/纹理跨格式尽量保留，丢失即披露；空场景产出合法空文件 + 警告 |
| `lod` | 多级细节链（`--levels --ratio`） | level0 原样，逐级单调下降 |
| `optimize` | 一站式轻量化（减面 + meshopt/draco + 贴图压缩/降采样） | 依赖不可用时降级并披露，不失败 |
| `doctor` | 环境自检（Tier0/Tier1 就绪性、uv 安装指引） | `--json` 输出机器可读结果 |

## 🤖 Agent 契约

退出码（Agent 按码决策）：

| 码 | 含义 |
|---|---|
| 0 | 成功（可含非致命警告，读 `warnings[]`） |
| 2 | 输入不可读（路径/权限/解析失败——截断、损坏、垃圾内容均归此码） |
| 3 | 格式不支持（FBX 等先经 DCC 导出） |
| 4 | 参数冲突 / 拒绝覆盖（覆盖需显式 `--overwrite`；输出 == 输入一律拒绝） |
| 5 | Tier1 执行器不可用（stderr 附安装指引） |
| 6 | 算法在当前输入上失败 |
| 7 | 资源超限（>500 万面 / >500MB，`--force` 一次性放行） |
| 8 | 内部错误 |

用法错误统一算 4。任何非 0 退出（含预加载失败的 2/3/4/5）都会写一份最小失败 manifest：`errors[]` 带原因、`params.failed_early: true`、输入统计以 0 值兜底，`--json` 时进 stdout。

每条命令在 `<输入名>.meshify/` 下写 `<输入名>.<op>.report.json`，内容与 `--json` 的 stdout 一致。效果看 `metrics.face_reduction / byte_reduction`，降级看 `warnings[].code`——字段级文档与 22 个警告码全表见 [report-schema.md](skills/meshify/references/report-schema.md)，排障见 [troubleshooting.md](skills/meshify/references/troubleshooting.md)。

## ⚙️ 双层内核（Tiering）

| 层 | 技术 | 覆盖 | 启动条件 |
|---|---|---|---|
| **Tier0** `ts-wasm` | TypeScript + WASM（gltf-transform / meshoptimizer / earcut） | glb / gltf / obj / stl / ply 的全命令 | Node ≥ 18.17，零 Python 依赖 |
| **Tier1** `python-uv` | Python（uv 管理；trimesh / gmsh / OpenCASCADE） | STEP/STP 等 CAD 网格化、跨内核交叉验证 | `uv sync`（`meshify doctor` 引导安装） |

路由规则：STEP 输入强制 Tier1，未装报 exit 5；动画 / 蒙皮输入强制 Tier0（保动画）；其余默认 Tier0。`--tier auto|ts|py` 可干预，`--tier py` 走 Python 实现，manifest 结构与 Tier0 完全一致。详见 [tiering.md](skills/meshify/references/tiering.md)。

## 📁 输出布局

```
model.glb
model.meshify/
  ├─ model.inspect.report.json      # 各命令报告（工具日志，可自动覆盖）
  ├─ model.simplified.glb           # 单文件产物（覆盖需 --overwrite）
  ├─ model.segment-plane.glb        # 分割合并产物（部件级 scene）
  ├─ model.lod0.glb / lod1.glb ...  # LOD 链
  └─ model.optimized.preview.html   # --preview-html 自包含对比页
```

## 🧪 开发

```bash
pnpm build                          # 构建（core / kernel-ts / cli）
pnpm test                           # 全套（无 uv 时 Tier1 用例自动 skip）
pnpm test -- tests/ts/quality.test.ts
node fixtures/generate.mjs          # 重新生成黄金样本（STEP 部分需 uv）
node fixtures/generate.mjs --big    # 追加 >500 万面大网格（配合 MESHIFY_TEST_BIG=1）
MESHIFY_TEST_BIG=1 pnpm test        # 含资源防护（exit 7）用例
```

质量断言独立于内核实现（自研 Hausdorff 采样 / 边界边水密计数），双内核一致性测试要求同一输入在 Tier0/Tier1 上顶点、面数、材质、贴图、逐子网格统计与 bbox 完全一致。

CI（[ci.yml](.github/workflows/ci.yml)）：win/mac/linux × Node 18/20/22 的 Tier0 矩阵 + 三平台 uv 全链路 Tier1 作业 + 手动触发的大网格防护作业。

> 注：根 `package.json` 的 `pnpm.overrides` 将 ndarray-pixels 的 sharp 钉在 0.33.5 —— sharp 0.35 系的 linux/macOS 预编译 libvips 缺 OpenJPEG，模块加载即崩（[sharp#4475](https://github.com/lovell/sharp/issues/4475)），升级前请先确认上游已修复。

<details>
<summary>仓库结构</summary>

```
packages/core          契约层：zod schema / 警告码 / 退出码 / Tier 路由 / Python 桥
packages/kernel-ts     Tier0 内核：io/inspect/simplify/segment/texture/convert/lod/optimize
packages/cli           commander CLI：8 命令 + 输出管理 + before/after 预览 HTML
packages-py/kernel-py  Tier1 内核：trimesh/gmsh 服务层（uv run python -m meshify_kernel payload.json）
skills/meshify         Agent Skill 本体：SKILL.md + references/ + 安装器
tests/ts               契约(zod×ajv) / 质量(Hausdorff·水密性) / 单命令 / 退出码 / 双内核一致性 / e2e
fixtures               黄金样本生成器 + 提交的生成物（多材质/开口壳/STL/STEP/蒙皮动画/空几何）
```

</details>

## 📚 文档

- [SKILL.md](skills/meshify/SKILL.md) — Skill 用法总览与决策树
- [references/](skills/meshify/references/) — 各命令细节、报告 schema、Tier 仲裁、排障
- [report-schema.md](skills/meshify/references/report-schema.md) — `meshify.report/v1` 字段级文档与 22 个警告码

## 🤝 贡献

欢迎 issue 与 PR。改动后请保证 `pnpm build && pnpm test` 全绿；涉及契约（退出码 / 警告码 / manifest schema）的变更请同步更新 [references/](skills/meshify/references/) 与测试。

## License

[MIT](LICENSE) © 2026 Leo Xie
