# cad-step —— STEP/STP CAD 处理（Tier1）

STEP（ISO 10303）是工业 CAD 的 B-rep 中性格式，**只有 Tier1 能读**（gmsh 内置 OpenCASCADE 内核）。
Tier0 没有也不该有解析能力——STEP 输入在 Tier1 未就绪时 exit 5 + 安装指引，绝不静默降级。

## 安装（一次性）

```bash
meshify doctor --install-uv        # 装 uv（单文件安装器，不污染系统）
cd <仓库>/packages-py/kernel-py && uv sync
meshify doctor                     # 验证：Tier1 import 深检 [ok]
```

国内网络先设镜像（PowerShell `set` / bash `export`）：

```
UV_DEFAULT_INDEX=https://pypi.tuna.tsinghua.edu.cn/simple
```

依赖约 200 MB（gmsh 自带 OCC 内核是大头），Python ≥ 3.12 由 uv 自动管理。

## 转换语义

```bash
meshify convert part.step --to glb
meshify inspect part.step          # 只看统计，不落产物
meshify simplify part.step --ratio 0.3     # 先转后减面（或分两步更可控）
```

- **网格化精度**：目标边长 = 包围盒对角线 / resolution（默认 100）。
  想更精细/更粗糙，先 `convert`（或 inspect 参数 `resolution`）再后续处理
- **颜色分组**（styled_item AP203/AP214）：按 CAD 颜色分组，每组独立 PBR 子网格；
  无颜色回退浅灰哑光（metallic 0 / roughness 0.8，避免裸白）
- 颜色挂在体上未下传到面的文件：回退取所属体颜色（gmsh adjacencies）

## 网格化后的推荐管线

OCC 网格是几何精确但面数偏高的三角 soup：

```bash
meshify convert part.step --to glb              # → part.converted-glb.glb
meshify simplify part.converted-glb.glb --ratio 0.1 --error 0.002
meshify optimize part.converted-glb.glb --texture-size 1024   # 再压一层体积
```

## 常见问题

| 现象 | 原因/处理 |
|---|---|
| `exit 5` | Tier1 未装/未同步——按上面安装步骤；`meshify doctor` 看哪项 FAIL |
| `STEP 文件未生成任何三角面` | 文件只含线框/点，或损坏；在 CAD 软件里确认含实体 |
| 面数爆炸 | OCC 曲面加密；减小 resolution 参数（如 50） |
| 颜色丢失 | 源文件本身无 styled_item 颜色；转出后用 texture 命令补材质 |
| 双色实体拆件后单色 | Tier1 plane 切割取实体多数色（换截面水密）；connected 拆件颜色全保留 |
