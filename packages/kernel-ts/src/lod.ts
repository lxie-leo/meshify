import type { Document } from '@gltf-transform/core';
import { cloneDocument } from '@gltf-transform/functions';
import type { ReportWarning } from '@meshify/core';
import { collectPrimitives, totalFaces } from './document-utils.js';
import { simplifyDocument } from './simplify.js';

/**
 * LOD 链生成（Tier0）：lod_0 原样 + lod_i 按 ratio^i 逐级简化。
 *
 * 每级从原始文档深克隆后独立简化（不级联：级联误差会复利放大）；
 * 逐级指标（面数/顶点数）与告警聚合返回，供 manifest 的 outputs.lods 使用。
 */

export interface LodLevelOptions {
	/** 级数（含 lod_0 原样级），≥ 2 */
	levels: number;
	/** 每级保留面比例（几何级数），0 < ratio < 1 */
	ratio: number;
	error?: number;
	keepBorder?: boolean;
	minFaces?: number;
}

export interface LodLevel {
	level: number;
	/** 该级目标保留比例 */
	ratio: number;
	faces: number;
	vertices: number;
	document: Document;
}

export interface LodResult {
	levels: LodLevel[];
	warnings: ReportWarning[];
}

export async function generateLodLevels(
	source: Document,
	opts: LodLevelOptions,
	warnings: ReportWarning[] = [],
): Promise<LodResult> {
	const levels = Math.max(2, Math.floor(opts.levels));
	const ratio = Math.min(Math.max(opts.ratio, 0.01), 0.99);
	const out: LodLevel[] = [];

	const facesOf = (doc: Document): number => totalFaces(collectPrimitives(doc));
	const vertsOf = (doc: Document): number =>
		collectPrimitives(doc).reduce((s, p) => s + p.localPositions.length / 3, 0);

	// lod_0：原始
	out.push({
		level: 0,
		ratio: 1,
		faces: facesOf(source),
		vertices: vertsOf(source),
		document: source,
	});

	for (let i = 1; i < levels; i++) {
		const levelRatio = ratio ** i;
		const doc = cloneDocument(source);
		const result = await simplifyDocument(doc, {
			ratio: levelRatio,
			error: opts.error,
			keepBorder: opts.keepBorder,
			minFaces: opts.minFaces,
			warnings,
		});
		out.push({
			level: i,
			ratio: levelRatio,
			faces: result.facesAfter,
			vertices: vertsOf(doc),
			document: doc,
		});
	}

	return { levels: out, warnings };
}
