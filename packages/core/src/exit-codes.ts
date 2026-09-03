/**
 * 语义化退出码契约（与 docs/plan.md §3.4 对齐）。
 *
 * Agent 按 exit code 决定下一步动作；所有码都必须在 SKILL.md 中披露。
 */
export const EXIT_OK = 0;
export const EXIT_INPUT_UNREADABLE = 2;
export const EXIT_FORMAT_UNSUPPORTED = 3;
export const EXIT_PARAM_CONFLICT = 4;
export const EXIT_EXECUTOR_UNAVAILABLE = 5;
export const EXIT_ALGORITHM_FAILED = 6;
export const EXIT_RESOURCE_LIMIT = 7;
export const EXIT_INTERNAL = 8;

export const EXIT_CODES = {
	EXIT_OK,
	EXIT_INPUT_UNREADABLE,
	EXIT_FORMAT_UNSUPPORTED,
	EXIT_PARAM_CONFLICT,
	EXIT_EXECUTOR_UNAVAILABLE,
	EXIT_ALGORITHM_FAILED,
	EXIT_RESOURCE_LIMIT,
	EXIT_INTERNAL,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

/** CLI 内部统一错误类型：携带语义化退出码，顶层 catch 转 stderr + process.exit。 */
export class MeshifyError extends Error {
	readonly code: number;

	constructor(code: number, message: string) {
		super(message);
		this.name = 'MeshifyError';
		this.code = code;
	}
}
