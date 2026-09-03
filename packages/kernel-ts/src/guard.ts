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
		if (inputBytes > maxBytes) reasons.push(`文件 ${(inputBytes / 1024 / 1024).toFixed(1)}MB > ${(maxBytes / 1024 / 1024) | 0}MB`);
		if (totalFaces > maxFaces) reasons.push(`面数 ${totalFaces.toLocaleString()} > ${maxFaces.toLocaleString()}`);
		throw new MeshifyError(
			EXIT_RESOURCE_LIMIT,
			`资源超限：${reasons.join('，')}。建议：先用 inspect 评估、按子网格分块处理（segment connected 拆件后逐件处理），` +
				`或降低目标面数/纹理分辨率；确认要一次性处理请加 --force。`,
		);
	}
}
