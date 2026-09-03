# report-schema —— meshify.report/v1 字段文档

权威定义：`packages/core/src/schema.ts`（zod，运行时校验）与其导出的 JSON Schema
（draft-07，ajv 交叉校验）。本文是解读向摘要；两份 schema 定义由契约测试强制一致。

## 顶层

| 字段 | 类型 | 说明 |
|---|---|---|
| `schema` | `"meshify.report/v1"` | 契约版本 |
| `tool` | `{name, version, tier}` | `tier`: `ts-wasm` \| `python-uv` |
| `command` | string | inspect/simplify/segment/texture/convert/lod/optimize |
| `input` | InputInfo | 输入侧统计 |
| `output` | OutputInfo \| null | inspect 为 null |
| `params` | object | 命令参数原样回显（CLI 组装值，非用户原始字符串） |
| `metrics` | Metrics | 削减/误差/部件/LOD/耗时 |
| `warnings` | Warning[] | 显式降级披露（码表见 troubleshooting.md） |
| `errors` | string[] | 非空即失败 |
| `exit_code` | int | 与进程退出码一致 |

## InputInfo

`path` `format` `bytes` `vertices` `faces` `meshes[]` `materials` `textures[]` `bbox` `has_animation`

- `meshes[]`: `{name, vertices, faces, material(null|string), has_uv, has_normals, skipped?}`
- `textures[]`: `{uri, mime(null), bytes, resolution(null|"WxH")}`
- `bbox`: `[[minX,minY,minZ],[maxX,maxY,maxZ]]` 或 null（空几何）
- `has_animation`: 含 animations/skins（Tier1 路线恒 false——路由层已拦截）

## OutputInfo

`path` `format` `bytes` `vertices` `faces` `files[]`

- `bytes`: 主产物单文件大小（多部件命令为部件字节总和）
- `files[]`: `{path, bytes, role}`，role ∈ `asset|preview|report|part|lod`
  ——Agent 拿全部产物路径的唯一来源

## Metrics

| 字段 | 出现于 | 说明 |
|---|---|---|
| `duration_ms` | 全部 | 耗时（必有） |
| `face_reduction` | 产出面数的命令 | 1 - out_faces/in_faces |
| `byte_reduction` | 同上 | 1 - out_bytes/in_bytes（绑贴图后可为负） |
| `ratio_actual` | simplify | 实际保留面比（受 min-faces 跳过影响） |
| `max_error_normalized` | Tier0 simplify | 归一化几何偏差上界（meshopt error 语义） |
| `parts[]` | segment | `{index, path, vertices, faces}` 逐部件 |
| `lod_levels[]` | lod | `{level, path, faces, vertices, bytes, ratio}` 逐级 |
| `derives_from` | 派生产物 | 源文件路径 |
| `tier_note` | 全部 | 本次路由/执行说明（文字说明） |

## 消费建议（Agent）

1. `exit_code !== 0` → 按码行动（troubleshooting.md 的动作表）
2. `errors[]` 非空 → 即使 exit 0 也要读（部分成功场景 exit 7 时 errors 有详情）
3. 验收看 `metrics.face_reduction/byte_reduction`；质量存疑看 `max_error_normalized`
4. 交付产物路径从 `output.files[]` 取（不要自己拼路径）
5. `warnings` 里出现 `MATERIAL_DEGRADED_TO_BASE_COLOR`/`TIER_DOWNGRADED` 时，
   向用户说明降级原因与规避方式（对应 references 文档）
