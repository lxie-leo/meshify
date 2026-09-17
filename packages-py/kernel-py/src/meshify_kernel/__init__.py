"""meshify Tier1 Python 内核.

协议（与 packages/core/src/types.ts + schema.ts 严格对齐）：
- 入口：``uv run python -m meshify_kernel <payload.json>``
- payload: {command, params, input, output?, output_dir?, force?, overwrite?}
- stdout: 完整 ``meshify.report/v1`` manifest JSON（TS 侧 zod 复验）
- 进程退出码 = manifest.exit_code（语义与 TS 侧一致：0/2/3/4/6/7/8）

服务层设计（一次调用起一个进程，用完即退，不是常驻服务）：
- 不依赖 FastAPI/数据库/固定目录，输入输出路径全部由 payload 直接给出
- 覆盖规则与 CLI 一致：分割会生成 part_000.glb、part_001.glb……这些文件
  名运行前并不知道，Python 侧对它们同样执行「不覆盖已有文件」的约定
- 所有降级、近似、跳过都必须带协议警告码写进 manifest，绝不悄悄处理
"""

__version__ = "0.1.0"

TOOL_NAME = "meshify"
REPORT_SCHEMA = "meshify.report/v1"
TIER = "python-uv"
