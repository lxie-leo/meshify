# meshify-kernel (Tier1)

meshify 的 Python 增强内核。CLI 通过

```
uv run python -m meshify_kernel <payload.json>
```

以一次性子进程调用本内核；stdout 输出完整 `meshify.report/v1` manifest，
进程退出码 = manifest.exit_code（语义与 TS 侧一致）。

## 能力

- **STEP/STP CAD 读取**（gmsh OpenCASCADE 内核，按颜色分组、独立 PBR 材质）
  —— Tier0 无法处理，是 Tier1 存在的首要原因
- QEM 简化（pyfqmr，逐子网格保材质 + UV 最近邻重映射）
- 三模式分割（connected / plane / semantic，跨子网格焊接）
- 五投影 UV 贴图（uv/planar/cylindrical/spherical/box）
- 格式转换（glb/gltf/obj/stl/ply）
- LOD 链、optimize（无压缩基线：几何压缩属 Tier0 WASM 能力，显式披露而非假装）

## 安装

```
cd packages-py/kernel-py
uv sync
```

国内网络可先配置镜像：`set UV_DEFAULT_INDEX=https://pypi.tuna.tsinghua.edu.cn/simple`

## 服务层来源

迁移自 maestro backend `services/model_edit/`（简化/分割/贴图/STEP），
剥离 FastAPI/DB；几何算法与防坑逻辑原样保留，警告改为契约警告码写入 manifest。
