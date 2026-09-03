"""meshify Tier1 Python 内核.

契约（与 packages/core/src/types.ts + schema.ts 严格对齐）：
- 入口：``uv run python -m meshify_kernel <payload.json>``
- payload: {command, params, input, output?, output_dir?, force?, overwrite?}
- stdout: 完整 ``meshify.report/v1`` manifest JSON（TS 侧 zod 复验）
- 进程退出码 = manifest.exit_code（语义与 TS 侧一致：0/2/3/4/6/7/8）

服务层迁移自 maestro backend（model_edit*.py），改动点：
- 剥离 FastAPI/DB/文件路由（settings → payload 路径直传）
- 输出路径/覆盖判定由 CLI 预声明，Python 侧对未预声明的部件文件同样强制
- 警告以契约警告码写入 manifest（绝不信默降级）
"""

__version__ = "0.1.0"

TOOL_NAME = "meshify"
REPORT_SCHEMA = "meshify.report/v1"
TIER = "python-uv"
