# convert —— 格式转换

## 语法

```
meshify convert <input> --to <glb|gltf|obj|stl|ply>
```

`--to` 默认 `glb`（单文件最通用）。同格式转换被拒（exit 4）——重新编码请先转中间格式。
`-o` 显式输出路径的扩展名必须与 `--to` 一致（否则 exit 4，防 STL 字节落进 .glb 名的坏产物）。

## 路线

- **Tier0**（glb/gltf/obj/stl/ply 输入）：读入重建为 glTF Document 后导出
  - OBJ 读入：自动找同名 `.mtl` 与引用贴图，材质转 PBR
  - glTF 输出：外部 `.bin` 与贴图伴生落盘在产物同目录（manifest.files 逐个列出，搬运时一并带走）
  - OBJ 输出：主文件 + `.mtl` + 伴生贴图（manifest.files 逐个列出）
- **Tier1**（step/stp 输入，或 `--tier py`）：STEP 经 OCC 网格化 → 颜色分组 → 目标格式
  （细节见 cad-step.md）

## 保真与披露

- 材质零丢失是硬约束（坑 1）；OBJ→GLB 等价材质合并时写 `MATERIALS_MERGED`
- STL/PLY 无材质语义：转出 GLB 时只有几何（贴图请走 texture 命令）
- 动画/蒙皮在 Tier0 路线结构性保留；`--tier py` 则会被 trimesh 丢弃（路由层已强制拦截）
- obj/stl/ply 产物统计以读回验证为准（`metrics` 反映实际文件，非内存估计）

## 产物

`<输入名>.meshify/<输入名>.converted-<to>.<ext>`（OBJ 另有伴生文件）。

## 常见组合

```bash
meshify convert model.obj --to glb            # OBJ（含 mtl+贴图）打包成单文件
meshify convert part.step --to glb            # CAD → Web（需 Tier1）
meshify convert model.glb --to stl            # 交给切片软件
meshify convert model.glb --to gltf           # 需要文本格式排查问题
```
