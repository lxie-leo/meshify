import { MeshifyError, EXIT_RESOURCE_LIMIT } from '@meshify/core';

/**
 * 资源防护（全命令共用）：面数/字节上限保护（大模型防护，M2 验收项）。
 * 默认 >500 万面或 >500MB 拒绝并提示分块，`--force` 显式覆盖。
 */
export const DEFAULT_MAX_FACES = 5_000_000;
export const DEFAULT_MAX_BYTES = 500 * 1024 * 1024;

export interface GuardOptions {
	maxFaces?: number;
	maxBytes?: number;
	force?: boolean;
}

export function assertResourceLimits(inputBytes: number, totalFaces: number, opts: GuardOptions = {}): void {
	if (opts.force) return;
	const maxFaces = opts.maxFaces ?? DEFAULT_MAX_FACES;
	const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
	if (inputBytes > maxBytes || totalFaces > maxFaces) {
		const reasons: string[] = [];
		if (inputBytes > maxBytes) reasons.push(`file ${(inputBytes / 1024 / 1024).toFixed(1)}MB > ${(maxBytes / 1024 / 1024) | 0}MB`);
		if (totalFaces > maxFaces) reasons.push(`faces ${totalFaces.toLocaleString()} > ${maxFaces.toLocaleString()}`);
		throw new MeshifyError(
			EXIT_RESOURCE_LIMIT,
			`Resource limit exceeded: ${reasons.join('; ')}. Suggestion: evaluate with inspect first and work per-submesh in batches ` +
				`(segment connected, then process part by part), or lower the target face count/texture resolution; to process in one shot, pass --force.`,
		);
	}
}
