import {
	REPORT_SCHEMA,
	TOOL_NAME,
	TOOL_VERSION,
	type FileInfo,
	type InputInfo,
	type MeshifyReport,
	type Metrics,
	type OutputInfo,
} from './types.js';
import type { Tier } from './tier-orchestrator.js';
import type { ReportWarning } from './warnings.js';

export interface ReportDraft {
	command: string;
	input: InputInfo;
	output?: OutputInfo | null;
	params: Record<string, unknown>;
	metrics?: Partial<Metrics>;
	warnings?: ReportWarning[];
	errors?: string[];
	exitCode?: number;
	tier?: Tier;
	durationMs?: number;
}

/** 组装 manifest（plan §3.3 契约；幂等凭证 = params 全量回显 + derives_from 血缘）。 */
export function generateReport(draft: ReportDraft): MeshifyReport {
	const inputFaces = draft.input.faces;
	const outputFaces = draft.output?.faces ?? null;
	const inputBytes = draft.input.bytes;
	const outputBytes = draft.output?.bytes ?? null;

	const metrics: Metrics = {
		duration_ms: Math.round(draft.durationMs ?? 0),
		derives_from: draft.input.path,
		...draft.metrics,
	};
	if (outputFaces !== null && inputFaces > 0) {
		metrics.face_reduction = round(1 - outputFaces / inputFaces);
		if (draft.command === 'simplify' || draft.command === 'optimize') {
			metrics.ratio_actual = round(outputFaces / inputFaces);
		}
	}
	if (outputBytes !== null && inputBytes > 0) {
		metrics.byte_reduction = round(1 - outputBytes / inputBytes);
	}

	return {
		schema: REPORT_SCHEMA,
		tool: { name: TOOL_NAME, version: TOOL_VERSION, tier: draft.tier ?? 'ts-wasm' },
		command: draft.command,
		input: draft.input,
		output: draft.output ?? null,
		params: draft.params,
		metrics,
		warnings: draft.warnings ?? [],
		errors: draft.errors ?? [],
		exit_code: draft.exitCode ?? 0,
	};
}

/** 汇总输出文件清单的辅助函数。 */
export function makeOutputInfo(
	path: string,
	format: string,
	bytes: number,
	vertices: number,
	faces: number,
	files: FileInfo[],
): OutputInfo {
	return { path, format, bytes, vertices, faces, files };
}

export function fileEntry(path: string, bytes: number, role: FileInfo['role']): FileInfo {
	return { path, bytes, role };
}

function round(n: number, digits = 6): number {
	const f = 10 ** digits;
	return Math.round(n * f) / f;
}
