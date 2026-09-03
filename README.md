# Meshify

> 三维模型轻量化与优化 Agent Skill —— 一条 `meshify` CLI 完成减面、拆件、贴图、格式转换、LOD 与 Web 交付优化，以**语义化退出码 + `meshify.report/v1` JSON 报告**作为 Agent 可靠消费的输出契约，**绝不静默降级**。

[![CI](https://github.com/lxie-leo/meshify/actions/workflows/ci.yml/badge.svg)](https://github.com/lxie-leo/meshify/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-informational.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A518.17-339933?logo=node.js&logoColor=white)](packages/cli/package.json)
[![Tier0](https://img.shields.io/badge/Tier0-zero--python-646CFF?logo=typescript&logoColor=white)](#-双层内核-tiering)

Meshify 把三维模型处理成 **Web / AR / 移动端可交付**的形态。它首先为 AI Agent（Claude Code、Cursor、Codex 等）设计：每条命令都产出结构化 manifest，任何降级（自动补 UV、贴图剥离、碎片面保留……）都以警告码显式披露——**Agent 依据报告决策，而非猜测**。同时也是开发者可直接使用的 `meshify` CLI。

**输入格式**：`glb` / `gltf` / `obj` / `stl` / `ply` 开箱即用；`step` / `stp`（CAD）走 Tier1 内核。

## ✨ 特性

- **一条 CLI，八个命令** — `inspect` / `simplify` / `segment` / `texture` / `convert` / `lod` / `optimize` / `doctor`
- **Agent 优先的输出契约** — 语义化退出码（0/2/3/4/5/6/7/8）+ `meshify.report/v1` manifest，失败不伪造报告，降级必带警告码
- **零配置即用（Tier0）** — Node ≥ 18.17 + WASM 几何内核（gltf-transform / meshoptimizer / earcut），无需 Python
- **CAD 增强（Tier1）** — STEP/STP 经 Python（uv 管理）+ gmsh/OpenCASCADE 网格化，未装时明确报错并给安装指引
- **安全默认** — 源文件永不改动；产物统一写入 `<输入名>.meshify/` 目录；覆盖必须显式 `--overwrite`
- **质量可验证** — 自研 Hausdorff 采样与水密性计数断言，双内核一致性由测试套件保障
- **before/after 预览** — `--preview-html` 生成的自包含对比页，浏览器直接打开

## 📦 安装

**作为 Agent Skill**（Claude Code / Cursor / Codex / Qoder / CodeBuddy / Comate 等）：

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
# 第一步永远是结构分析：面数 / 子网格 / 材质 / 贴图 / 包围盒
$ meshify inspect fixtures/glb/multimat.glb --json
{
  "schema": "meshify.report/v1",
  "tool": { "name": "meshify", "version": "0.1.0", "tier": "ts-wasm" },
  "command": "inspect",
  "input": { "format": "glb", "vertices": 72, "faces": 36, "meshes": [...], "bbox": [...] },
  "warnings": [],
  "exit_code": 0
}

# 减面到 30%（ratio = 保留率；逐子网格保材质，<200 面跳过并警告）
meshify simplify model.glb --ratio 0.3

# 精确目标面数（与 --ratio 互斥）
meshify simplify model.glb --target-faces 50000

# 装配体拆件 / 平面切割（默认封口保水密）
meshify segment model.glb --mode connected
meshify segment model.glb --mode plane --axis x --position 0

# Web 交付一步到位：减面 + 纹理降采样 + meshopt/Draco 压缩
meshify optimize model.glb --ratio 0.5 --texture-size 2048

# STEP（CAD）→ GLB：自动路由到 Tier1，未装时给安装指引
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
| `convert` | 格式互转（glb/gltf/obj/stl/ply；STEP 读入走 Tier1） | 材质/纹理跨格式尽量保留，丢失即披露 |
| `lod` | 多级细节链（`--levels --ratio`） | level0 原样，逐级单调下降 |
| `optimize` | 一站式轻量化（减面 + meshopt/draco + 贴图压缩/降采样） | 依赖不可用时降级并披露，不失败 |
| `doctor` | 环境自检（Tier0/Tier1 就绪性、uv 安装指引） | `--json` 输出机器可读结果 |

## 🤖 Agent 契约

**退出码**（Agent 按码决策）：

| 码 | 含义 |
|---|---|
| 0 | 成功（可含非致命警告，读 `warnings[]`） |
| 2 | 输入不可读（路径/权限） |
| 3 | 格式不支持（FBX 等先经 DCC 导出） |
| 4 | 参数冲突 / 拒绝覆盖（覆盖需显式 `--overwrite`；输出 == 输入一律拒绝） |
| 5 | Tier1 执行器不可用（stderr 附安装指引） |
| 6 | 算法在当前输入上失败 |
| 7 | 资源超限（>500 万面 / >500MB，`--force` 一次性放行） |
| 8 | 内部错误 |

预加载失败（2/3/4/5）直接在 stderr 输出诊断信息和退出码，不伪造 manifest；用法错误统一收敛进 4。

**manifest**：每条命令在 `<输入名>.meshify/` 写 `<输入名>.<op>.report.json`，`--json` 时同一内容进 stdout。`metrics.face_reduction / byte_reduction` 看效果，`warnings[].code` 看降级（16 个警告码全表与字段级文档见 [report-schema.md](skills/meshify/references/report-schema.md) 与 [troubleshooting.md](skills/meshify/references/troubleshooting.md)）。

## ⚙️ 双层内核（Tiering）

| 层 | 技术 | 覆盖 | 启动条件 |
|---|---|---|---|
| **Tier0** `ts-wasm` | TypeScript + WASM（gltf-transform / meshoptimizer / earcut） | glb / gltf / obj / stl / ply 的全命令 | Node ≥ 18.17，零 Python 依赖 |
| **Tier1** `python-uv` | Python（uv 管理；trimesh / gmsh / OpenCASCADE） | STEP/STP 等 CAD 网格化、跨内核交叉验证 | `uv sync`（`meshify doctor` 引导安装） |

路由规则（`--tier auto|ts|py` 可干预）：STEP 输入强制 Tier1（未装报 exit 5，绝不降级）；动画/蒙皮输入强制 Tier0（保动画）；其余默认 Tier0，`--tier py` 走 Python 实现，manifest 结构完全一致。详见 [tiering.md](skills/meshify/references/tiering.md)。

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
- [report-schema.md](skills/meshify/references/report-schema.md) — `meshify.report/v1` 字段级文档与 16 个警告码

## 🤝 贡献

欢迎 issue 与 PR。改动后请保证 `pnpm build && pnpm test` 全绿；涉及契约（退出码 / 警告码 / manifest schema）的变更请同步更新 [references/](skills/meshify/references/) 与测试。

## License

[MIT](LICENSE) © 2026 Leo Xie
