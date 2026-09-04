---
name: meshify
description: 三维模型轻量化与优化工具链。输入 glb/gltf/obj/stl/ply（Tier0 即用）/ step/stp（Tier1），输出减面、分割、贴图、格式转换、LOD、Web 交付优化产物 + meshify.report/v1 结构化报告。任何「模型太大/面数太高/CAD 文件要转 GLB/要拆件/要压纹理」的任务先用本工具。
---

# meshify —— 3D 模型轻量化 Agent Skill

## 能力定位

把三维模型处理成 Web/AR/移动端可交付的形态：减面、拆件、贴图、转格式、LOD、一键压缩。
所有命令输出 `meshify.report/v1` manifest（JSON），按语义退出码报告结果——**依据报告决策，而非猜测**。

- **零配置即用**：Node ≥ 18.17 即可跑（Tier0：WASM 几何内核）
- **CAD 增强**：STEP/STP 需要 Tier1（Python/uv + gmsh），未装时明确报 exit 5 并给安装指引，绝不静默降级
- **默认不覆盖**：产物写 `<输入目录>/<输入名>.meshify/`，重复执行幂等安全；覆盖必须显式 `--overwrite`

## 支持矩阵（速查）

| 命令 | 作用 | Tier0 | Tier1 | 关键参数 |
|---|---|---|---|---|
| inspect | 结构分析（面数/材质/贴图/包围盒） | ✅ | ✅（STEP） | `--json` |
| simplify | QEM 减面（逐子网格保材质） | ✅ | ✅ | `--ratio 0.5`、`--target-faces`、`--min-faces` |
| segment | 拆件：connected/plane/semantic | ✅ | ✅ | `--mode`、`--axis x --position 0.5`、`--cap` |
| texture | 五投影 UV + 贴图绑定 | ✅ | ✅ | `--map box`、`--image`、`--metallic/--roughness` |
| convert | glb/gltf/obj/stl/ply 互转 | ✅ | ✅（STEP 读入） | `--to glb`、`--up-axis x\|auto`（STEP 躺着建模时扶正/自动判定） |
| lod | 多级 LOD链 | ✅ | ✅ | `--levels 3 --ratio 0.5` |
| optimize | Web 交付一键优化（meshopt+WebP） | ✅ | ⚠️ 无压缩基线 | `--ratio`、`--texture-size` |
| doctor | 环境自检 + 安装引导 | ✅ | 检测 | `--json`、`--install-uv` |

输入格式：`glb gltf obj stl ply`（Tier0 直接读）/ `step stp`（仅 Tier1）。FBX 等不支持（exit 3）。

## 决策树（按序执行）

```
拿到模型
  ├─ 不了解结构？ → meshify inspect model.glb --json   # 面数/子网格/材质/贴图/动画 全部拿到
  ├─ 是 STEP？ → meshify doctor 先确认 Tier1；未装按指引装（见 references/cad-step.md）
  ├─ 太大/面数高？
  │    ├─ 单体模型 → meshify simplify --ratio 0.5
  │    ├─ 装配体要拆 → meshify segment --mode connected
  │    └─ 要一刀两半 → meshify segment --mode plane --axis x
  ├─ 要上纹理 → meshify texture --map box --image tex.png
  ├─ 要换格式 → meshify convert --to stl|obj|ply|gltf
  ├─ 要分级加载 → meshify lod --levels 3 --ratio 0.5
  └─ 一步到位 Web 交付 → meshify optimize --ratio 0.5 --texture-size 2048
每次命令后：读 report.json（或 --json stdout）核对 warnings 与削减指标
```

**产物命令默认带 `--preview-html`**（simplify/segment/texture/convert/lod/optimize）：生成
before/after 对比页，肉眼核对效果最快。关 = 省略该 flag——用户明确说不要预览、或批量/
无人值守跑批时省略（HTML 内嵌 base64 模型，体积 ≈ 产物 1.33 倍；three.js 走 CDN 需联网）。

**semantic 的边界**：`--mode semantic` 认的是「朝向+位置」聚类，不是零件语义。装配体拆件用 connected；
想按外观分区（平面/曲面/不同朝向）才用 semantic。

## 命令示例

```bash
# 结构分析（Agent 第一步；--json 拿完整 manifest）
meshify inspect model.glb --json

# 减面到 30%（逐子网格保材质；<200 面子网格跳过并警告）
meshify simplify model.glb --ratio 0.3 --preview-html

# 精确目标面数 + 误差上限
meshify simplify model.glb --target-faces 50000 --error 0.005 --preview-html

# 连通域拆件（装配体首选；丢弃 <50 面碎件）
meshify segment model.glb --mode connected --min-faces 50 --preview-html

# 平面切割：滑块语义（-1..1 映射包围盒）或原生坐标二选一
meshify segment model.glb --mode plane --axis x --position 0 --preview-html
meshify segment model.glb --mode plane --origin "0,10,0" --normal "0,1,0"

# 贴图（盒式投影，无 UV 时自动生成并警告披露）
meshify texture model.glb --map box --image diffuse.png --metallic 0.1 --preview-html

# 格式转换（输出 STL 给切片软件）
meshify convert model.glb --to stl --preview-html

# 三级 LOD（100%/50%/25%）
meshify lod model.glb --levels 3 --ratio 0.5 --preview-html

# Web 交付：减面 + 纹理 2048 上限 + meshopt 压缩
meshify optimize model.glb --ratio 0.5 --texture-size 2048 --preview-html

# STEP（CAD）→ GLB：需要 Tier1
meshify convert part.step --to glb

# STEP 里躺着建模的部件（真实朝上轴非 CAD 惯例 Z）扶正后再转
meshify convert part.step --to glb --up-axis auto --preview-html

# 环境自检（装 Tier1 前后都跑一次）
meshify doctor
```

通用选项（全部命令）：`-o <path>` 显式输出路径、`--json` manifest 到 stdout、`--overwrite`、
`--tier auto|ts|py`、`--force` 超限一次性处理。`--preview-html` 见决策树后的默认策略——
产物命令默认带上（省略即关闭）。

## 报告解读（meshify.report/v1）

每条命令在 `<输入名>.meshify/<输入名>.<op>.report.json` 写 manifest（报告是工具自有日志，可自动覆盖；
模型产物才受 `--overwrite` 约束）。`--json` 时同一内容进 stdout。

```jsonc
{
  "schema": "meshify.report/v1",
  "tool": { "name": "meshify", "version": "0.1.0", "tier": "ts-wasm" },  // 或 python-uv
  "command": "simplify",
  "input":  { "path": "...", "format": "glb", "vertices": 54, "faces": 32,
              "meshes": [ { "name": "boxA", "material": "red", "has_uv": true, ... } ],
              "materials": 3, "textures": [], "bbox": [[...],[...]], "has_animation": false },
  "output": { "path": "...glb", "bytes": 441100, "vertices": 14082, "faces": 14082,
              "files": [ { "path": "...", "bytes": 441100, "role": "asset" } ] },
  "params": { "ratio": 0.3 },
  "metrics": { "face_reduction": 0.7, "byte_reduction": 0.47, "duration_ms": 200 },
  "warnings": [ { "code": "SMALL_MESH_SKIPPED", "message": "...", "mesh": "boxA" } ],
  "errors": [],
  "exit_code": 0
}
```

**读法**：`metrics.face_reduction/byte_reduction` 看效果；`warnings[].code` 看降级（每条都是显式披露，
不是失败）；`errors` 非空即失败。警告码全表见 references/troubleshooting.md。

**失败路径同样产出 manifest**：非 0 退出码（输入不可读/参数冲突/空场景等早失败）时也会落
最小 manifest（`errors[]` 带原因、`params.failed_early: true`、输入统计 0 值兜底），
`--json` 下 stdout 契约不变——统一「先解析 stdout manifest，失败看 errors + exit_code」，
不必拿退出码猜。字段细节见 references/report-schema.md。

## 退出码契约（Agent 按码决策）

| 码 | 含义 | 下一步 |
|---|---|---|
| 0 | 成功 | 读 manifest |
| 2 | 输入不可读 | 检查路径/权限 |
| 3 | 格式不支持 | 转 glb 后重试（FBX 等先经 DCC 导出） |
| 4 | 参数冲突 / 拒绝覆盖 | 看报错信息改参数；确认覆盖加 `--overwrite` |
| 5 | Tier1 不可用 | `meshify doctor --install-uv` 后 `uv sync`（见 cad-step.md） |
| 6 | 算法失败 | 调参数（平面位置/聚类数），或先 segment 拆件 |
| 7 | 资源超限/部分成功 | `--force` 或先拆件分批 |
| 8 | 内部错误 | 附 report.json 反馈 |

## Tier 仲裁（何时走 Python）

1. 输入含**动画/蒙皮/morph** → 强制 Tier0（trimesh 管线会丢动画），写 `SKIN_ANIMATION_PRESERVED`
2. 输入是 **STEP** → 强制 Tier1；未装 → exit 5 + 安装指引（无 TS 回退，不降级）
3. 其余默认 Tier0；`--tier py` 显式要求时走 Tier1，Tier1 不可用则 exit 5
4. `optimize` 的 meshopt/draco/WebP 压缩是 Tier0 专属——`--tier py` 下输出未压缩基线并写 `TIER_DOWNGRADED` 披露

详见 references/tiering.md。

## 输出布局

```
model.glb
model.meshify/
  ├─ model.inspect.report.json      # 各命令报告
  ├─ model.simplified.glb           # 单文件产物
  ├─ model.segment-plane.glb        # 分割合并产物（部件级 scene）
  ├─ model.segment-plane/part_000.glb ...   # Tier1 多部件目录
  ├─ model.lod0.glb / lod1.glb ...  # LOD 链（Tier0）
  └─ *.preview.html                 # --preview-html 对比页（与产物同名，自包含单文件，可直接开浏览器）
```

## 排障指针

- 环境问题（WASM 加载失败 / uv 未装 / 磁盘不足）→ `meshify doctor`，或 references/troubleshooting.md
- STEP 转换失败/精度调整 → references/cad-step.md
- 各命令参数细节 → references/{simplify,segment,texture,convert,optimize}.md
- 双内核差异与一致性 → references/tiering.md；宿主兼容 → references/support-matrix.md
- manifest 字段级文档 → references/report-schema.md
