# troubleshooting —— 排障与警告码全表

## 退出码 → 动作

| 码 | 含义 | Agent 下一步 |
|---|---|---|
| 0 | 成功 | 读 manifest（warnings 也要读） |
| 2 | 输入不可读 | 检查路径/权限；`meshify inspect` 验证 |
| 3 | 格式不支持 | FBX 等先在 DCC 导 GLB |
| 4 | 参数冲突/拒绝覆盖 | 看信息改参数；确认覆盖 `--overwrite` |
| 5 | Tier1 不可用 | `meshify doctor --install-uv` → `uv sync`（cad-step.md） |
| 6 | 算法失败 | 调平面位置/聚类数；或先 connected 拆件分批。空场景（0 面）也归此码 |
| 7 | 资源超限/部分成功 | `--force` 一次或拆件 |
| 8 | 内部错误 | 附 report.json 反馈 |

## 警告码全表（全部是显式披露，不是失败）

| 码 | 场景 | 含义 |
|---|---|---|
| `SMALL_MESH_SKIPPED` | simplify/lod | 子网格 < min-faces，跳过简化原样保留（坑 12） |
| `MATERIAL_DEGRADED_TO_BASE_COLOR` | Tier1 简化/分割 | UV 无法重映射，材质降级仅 baseColor 标量（贴图剥离） |
| `UV_REMAP_APPROXIMATED` | Tier1 几何重建 | 塌缩/重组点 UV 按最近面重心插值（近似） |
| `NON_MANIFOLD_INPUT` | plane 切割 | 输入疑似重合壳/非流形，截面未能闭合封口 |
| `FRAGMENT_FACES_KEPT` | plane 封口 | 零面积碎片三角形保留（删了会开洞，坑 6） |
| `DOUBLE_SIDED_FORCED` | 分割/贴图产物 | 材质强制双面（开口壳防背面剔除，坑 3） |
| `TEXTURE_DOWNSCALED` | optimize | 贴图降采样（超过 `--texture-size`，坑 11） |
| `TEXTURE_FORMAT_CONVERTED` | optimize/texture | 非 PNG/JPEG 贴图规范化转 PNG（glTF 核心只内建这两种位图格式） |
| `TIER_DOWNGRADED` | tier 仲裁 | Tier1 不可用降级 Tier0 执行（STEP 除外——它直接 exit 5） |
| `SKIN_ANIMATION_PRESERVED` | tier 仲裁 | 动画输入强制 Tier0 保留动画 |
| `ATLAS_UV_IGNORED` | texture --map uv | 色块图集 UV 忽略，盒式回退（坑 2） |
| `AUTO_BOX_UV_GENERATED` | texture --map uv | 无 UV 自动盒式投影 |
| `PARTIAL_SUCCESS` | 多子网格处理 | 部分子网格失败（exit 7 伴随） |
| `MATERIALS_MERGED` | OBJ→GLB / simplify --merge | 等价材质/同材质子网格自动合并（坑 1 相关） |
| `MERGE_INCOMPATIBLE_FALLBACK` | simplify --merge | 同材质子网格顶点属性不兼容无法合并，回退逐子网格（几何/材质不受影响） |
| `INDEX_OUT_OF_RANGE` | OBJ 读入 | 面引用越界（不存在的顶点/UV/法线索引），越界分量按默认值兜底 |
| `SMALL_PARTS_DROPPED` | segment connected | 碎片部件丢弃（全丢时保留最大者） |
| `DRACO_UNAVAILABLE` | optimize draco | draco3dgltf 可选依赖缺失，几何压缩跳过 |

## 常见故障

**预览页白屏**：three.js CDN 不可达（页内自动 jsdelivr→unpkg 回退仍失败时显示错误层）——联网后重开。

**Tier1 import 深检 FAIL**：`cd packages-py/kernel-py && uv sync` 后重跑 `meshify doctor` 验证（doctor 每次都现场探测）。

**简化后面数没降**：全是 < min-faces 的小子网格（看 warnings）；调低 `--min-faces` 或确认输入。

**平面切割 exit 6「未与模型相交」**：`--position` 在 [-1,1] 之外或平面贴着包围盒表面；
用 inspect 的 bbox 换算原生坐标走 `--origin/--normal`。

**Windows 下中文乱码**：CLI 输出 UTF-8；旧终端（cmd 默认 GBK）先 `chcp 65001`。

**重复执行报输出已存在**：默认不覆盖是特性（幂等安全）；确认要覆盖加 `--overwrite`，
或换 `-o` 输出路径。

## 性能参考

- Tier0 热启动 < 0.5s；100 万面 simplify ~10s（WASM 多线程视平台）
- Tier1 冷启动 ~2s（uv run）；STEP 网格化与模型复杂度线性相关（10 万面级 ~5s）
- 预览页生成 < 0.5s（大 GLB base64 内嵌会放大 HTML 体积，属预期）
