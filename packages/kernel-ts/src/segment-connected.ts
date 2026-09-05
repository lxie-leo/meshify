import { warn, type ReportWarning } from '@meshify/core';
import type { PartGeometry, Soup } from './document-utils.js';
import { UnionFind, weldKey } from './geometry/union-find.js';

/**
 * 连通域分割（Tier0）：按共享边连通性拆分独立壳体。
 *
 * 移植自 maestro useThreeScene.ts 连通分量实现：
 * - 顶点按量化位置焊接（QUANT=1e6，绝对容差 1e-6）——跨子网格/跨材质的位置重合
 *   顶点可连通（STEP 多色零件导出的 glTF 常见：几何连续但索引隔离）
 * - 面数 < min-faces 的碎片部件丢弃；若全部会被丢则保留最大者（绝不输出空结果）
 */

export interface ConnectedSegmentResult {
	parts: PartGeometry[];
	warnings: ReportWarning[];
	totalComponents: number;
	droppedComponents: number;
}

export function segmentConnected(soup: Soup, opts: { minFaces?: number } = {}): ConnectedSegmentResult {
	const warnings: ReportWarning[] = [];
	const totalVerts = soup.positions.length / 3;
	const minFaces = Math.max(1, Math.floor(opts.minFaces ?? 1));

	// 1. 顶点焊接代表元
	const weldRep = new Map<string, number>();
	const welded = new Int32Array(totalVerts);
	for (let v = 0; v < totalVerts; v++) {
		const key = weldKey(soup.positions[v * 3], soup.positions[v * 3 + 1], soup.positions[v * 3 + 2]);
		const rep = weldRep.get(key);
		if (rep === undefined) {
			weldRep.set(key, v);
			welded[v] = v;
		} else {
			welded[v] = rep;
		}
	}

	// 2. 共享（焊接）边 → 同一连通域
	const uf = new UnionFind(soup.totalTriangles);
	const edgeFirst = new Map<string, number>();
	for (let t = 0; t < soup.totalTriangles; t++) {
		for (let k = 0; k < 3; k++) {
			const a = welded[soup.indices[t * 3 + k]];
			const b = welded[soup.indices[t * 3 + (k + 1) % 3]];
			if (a === b) continue; // 退化边（零面积三角形）
			const key = a < b ? `${a}_${b}` : `${b}_${a}`;
			const first = edgeFirst.get(key);
			if (first === undefined) edgeFirst.set(key, t);
			else uf.union(first, t);
		}
	}

	// 3. 收集部件并按面数降序命名（part_000 = 最大）
	const { compOf, count } = uf.compact();
	const trisOf: number[][] = Array.from({ length: count }, () => []);
	for (let t = 0; t < soup.totalTriangles; t++) trisOf[compOf[t]].push(t);
	const ordered = trisOf
		.map((triangles, idx) => ({ idx, triangles, faces: triangles.length }))
		.sort((x, y) => y.faces - x.faces || x.idx - y.idx);

	// 4. 碎片过滤（全被丢时保留最大者）
	let kept = ordered.filter((c) => c.faces >= minFaces);
	let droppedComponents = ordered.length - kept.length;
	if (kept.length === 0) {
		kept = [ordered[0]];
		droppedComponents = ordered.length - 1;
	}
	if (droppedComponents > 0) {
		const totalFaceCount = ordered.reduce((s, c) => s + c.faces, 0);
		const keptFaceCount = kept.reduce((s, c) => s + c.faces, 0);
		warnings.push(
			warn(
				'SMALL_PARTS_DROPPED',
				`${droppedComponents} fragment components with < ${minFaces} faces dropped (${totalFaceCount - keptFaceCount} faces total)`,
			),
		);
	}

	// 5. 部件内按源 primitive 分组（保持材质隔离，坑 1）
	const parts: PartGeometry[] = [];
	for (let i = 0; i < kept.length; i++) {
		const byPrim = new Map<number, number[]>();
		for (const t of kept[i].triangles) {
			const prim = soup.triPrim[t];
			const list = byPrim.get(prim) ?? [];
			list.push(t);
			byPrim.set(prim, list);
		}
		parts.push({
			name: `part_${String(i).padStart(3, '0')}`,
			groups: [...byPrim.entries()].map(([primIndex, triangles]) => ({ primIndex, triangles })),
		});
	}

	return { parts, warnings, totalComponents: count, droppedComponents };
}
