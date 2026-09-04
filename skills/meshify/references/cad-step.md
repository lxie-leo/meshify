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
- **up-axis 规范化**：STEP 坐标默认按 CAD 惯例视为 Z-up，glTF 规范要求 Y-up——产物统一旋转
  (x,y,z)→(x,z,−y)，manifest 写 `UP_AXIS_NORMALIZED` 披露。部分查看器会自动猜 Z-up
  显示原始 CAD（显得「正常」），但在严格 Y-up 的渲染器（three.js 等 Web 栈）里不转就是侧躺的
- **部件在源文件里躺着建模**（装配坐标系横放，真实朝上轴不是 Z）：STEP 不携带「哪个方向
  朝上」的信息，缺省 Z-up 猜不中时产物就侧躺——`--up-axis` 显式指定朝上轴扶正：

  ```bash
  meshify convert part.step --to glb --up-axis x      # 部件高度沿源 X 轴
  meshify convert part.step --to glb --up-axis=-x     # 反方向（负值必须用 = 传参）
  meshify convert part.step --to glb --up-axis auto   # 按几何特征自动判定
  ```

  取值 `x|y|z`（可加 `-` 前缀反向）或 `auto`（默认 `z`）。仅 convert 命令支持、仅 STEP
  输入有效（其他格式传了会 exit 4）；simplify 等命令的 STEP 直读路径仍按 Z-up 惯例，
  需要扶正先 convert。判定方法：看渲染里哪个维度是「高度」，对照 CAD 里该维度沿哪根轴

- **`--up-axis auto` 的判定逻辑与边界**（保守策略，宁可拒绝不静默猜错）：
  - 证据 = 底板上的安装孔模式——小半径圆柱孔的共面簇（≥3 个、横向铺开），用粗网格
    点包含测试区分真孔（圆心在空腔）与凸台台阶（圆心在实体内，如端子螺柱各段，
    它们轴向共面但不构成安装模式）
  - 恰一个轴向孔票数达标且 ≥1.5×次名 → 定轴；孔簇靠包围盒哪端定符号（孔所在面=底面）；
    孔簇在中部（侧安装耳）时用平面面积辅证
  - 高置信成功：manifest 写 `UP_AXIS_AUTO`（判定结论+依据）+ `params.up_axis_resolved`
  - 低置信（对称件/无安装孔/多向孔模式/两端都有孔）→ **exit 4 拒绝并列出候选参考**
    （法向各轴向的平面张数/面积占比），此时看渲染人工定轴后用 `x|y|z` 显式指定
  - 典型命中：底板+角孔的机箱/面板件、DIN 导轨电器；典型拒绝：方块、球、无孔铸件

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
