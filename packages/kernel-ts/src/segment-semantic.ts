import type { ReportWarning } from '@meshify/core';
import type { PartGeometry, Soup } from './document-utils.js';
import { faceNormalNormalized } from './geometry/normal.js';
import { kmeans } from './geometry/kmeans.js';
import { UnionFind, weldKey } from './geometry/union-find.js';

/**
 * 语义分割（Tier0）：法线 + 空间位置联合聚类 → 同标签连通切分 → 小碎块合并。
 *
 * 忠实移植 maestro model_edit_segment.py:segment_semantic：
 * - 聚类特征 = [面法线, 归一化面心]（逐实体各自归一化，零长轴 1e-12 兜底）
 * - 大网格采样训练（clusters*100），标签对全量预测；固定种子可复现
 * - 自适应最小部件面数 = max(10, 2% × 实体面数)
 * - 同标签连通切分后逐轮合并：目标取共享边最多的相邻部件（平手取面数更大者），
 *   悬空碎屑并入质心最近的「已达标注件」；保证部件完整一块、拆分无面丢失
 * - 部件预览色按黄金角取互斥色相（hsv(h, 0.62, 0.92)）
 *
 * 跨子网格焊接与 maestro _load_solids 语义一致（QUANT=1e6）。
 */

export interface SemanticSegmentResult {
	parts: PartGeometry[];
	/** 与 parts 对齐的预览色 [r,g,b]（0..1，黄金角色相） */
	partColors: [number, number, number][];
	warnings: ReportWarning[];
	totalComponents: number;
}

export function segmentSemantic(
	soup: Soup,
	opts: { clusters?: number } = {},
): SemanticSegmentResult {
	const warnings: ReportWarning[] = [];
	const nFaces = soup.totalTriangles;
	if (nFaces === 0) throw new Error('Mesh contains no triangles');
	const clusters = Math.max(2, Math.floor(opts.clusters ?? 8));

	// ---- 1. 跨子网格焊接 + 面邻接表 ----
	const totalVerts = soup.positions.length / 3;
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
	const edgeFirst = new Map<string, number>();
	const adjPairs: [number, number][] = [];
	for (let t = 0; t < nFaces; t++) {
		for (let k = 0; k < 3; k++) {
			const a = welded[soup.indices[t * 3 + k]];
			const b = welded[soup.indices[t * 3 + (k + 1) % 3]];
			if (a === b) continue;
			const key = a < b ? `${a}_${b}` : `${b}_${a}`;
			const first = edgeFirst.get(key);
			if (first === undefined) edgeFirst.set(key, t);
			else adjPairs.push([first, t]);
		}
	}

	// ---- 2. 实体级连通分量（语义聚类逐实体进行，与 maestro 逐 solid 一致）----
	const solidUf = new UnionFind(nFaces);
	for (const [a, b] of adjPairs) solidUf.union(a, b);
	const solid = solidUf.compact();
	const facesOfSolid: number[][] = Array.from({ length: solid.count }, () => []);
	for (let t = 0; t < nFaces; t++) facesOfSolid[solid.compOf[t]].push(t);
	// 邻接对按实体分桶（邻接对两端必属同一实体）
	const adjOfSolid: [number, number][][] = Array.from({ length: solid.count }, () => []);
	for (const pair of adjPairs) adjOfSolid[solid.compOf[pair[0]]].push(pair);

	// ---- 3. 逐实体：特征 → kmeans → 同标签连通 + 碎块合并 ----
	const allParts: number[][] = [];
	for (const faces of facesOfSolid) {
		if (faces.length === 0) continue;
		// 特征 = [面法线, 实体包围盒归一化面心]
		let minX = Infinity, minY = Infinity, minZ = Infinity;
		let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
		const centers = new Float64Array(faces.length * 3);
		const normals = new Float32Array(faces.length * 3);
		for (let i = 0; i < faces.length; i++) {
			const t = faces[i];
			const a = soup.indices[t * 3] * 3;
			const b = soup.indices[t * 3 + 1] * 3;
			const c = soup.indices[t * 3 + 2] * 3;
			const cx = (soup.positions[a] + soup.positions[b] + soup.positions[c]) / 3;
			const cy = (soup.positions[a + 1] + soup.positions[b + 1] + soup.positions[c + 1]) / 3;
			const cz = (soup.positions[a + 2] + soup.positions[b + 2] + soup.positions[c + 2]) / 3;
			centers[i * 3] = cx;
			centers[i * 3 + 1] = cy;
			centers[i * 3 + 2] = cz;
			faceNormalNormalized(
				soup.positions[a], soup.positions[a + 1], soup.positions[a + 2],
				soup.positions[b], soup.positions[b + 1], soup.positions[b + 2],
				soup.positions[c], soup.positions[c + 1], soup.positions[c + 2],
				normals, i * 3,
			);
			minX = Math.min(minX, cx); minY = Math.min(minY, cy); minZ = Math.min(minZ, cz);
			maxX = Math.max(maxX, cx); maxY = Math.max(maxY, cy); maxZ = Math.max(maxZ, cz);
		}
		const extX = Math.max(maxX - minX, 1e-12);
		const extY = Math.max(maxY - minY, 1e-12);
		const extZ = Math.max(maxZ - minZ, 1e-12);
		const features = new Float64Array(faces.length * 6);
		for (let i = 0; i < faces.length; i++) {
			features[i * 6] = normals[i * 3];
			features[i * 6 + 1] = normals[i * 3 + 1];
			features[i * 6 + 2] = normals[i * 3 + 2];
			features[i * 6 + 3] = (centers[i * 3] - minX) / extX;
			features[i * 6 + 4] = (centers[i * 3 + 1] - minY) / extY;
			features[i * 6 + 5] = (centers[i * 3 + 2] - minZ) / extZ;
		}
		const km = kmeans(features, faces.length, 6, {
			k: Math.min(clusters, faces.length),
			seed: 42,
			sampleLimit: clusters * 100,
		});

		// 同标签连通切分 + 小碎块合并（对齐 maestro _connected_parts）
		const minFaceCount = Math.max(10, Math.floor(faces.length * 0.02));
		const localIdx = new Map<number, number>();
		for (let i = 0; i < faces.length; i++) localIdx.set(faces[i], i);
		const localAdj: [number, number][] = [];
		for (const [ga, gb] of adjOfSolid[solid.compOf[faces[0]]]) {
			localAdj.push([localIdx.get(ga)!, localIdx.get(gb)!]);
		}
		for (const part of connectedPartsWithMerge(faces.length, km.labels, localAdj, centers, minFaceCount)) {
			allParts.push(part.map((i) => faces[i]));
		}
	}

	// ---- 4. 输出：按面数降序命名 + 黄金角预览色 ----
	allParts.sort((a, b) => b.length - a.length);
	const parts: PartGeometry[] = [];
	const partColors: [number, number, number][] = [];
	for (let i = 0; i < allParts.length; i++) {
		const byPrim = new Map<number, number[]>();
		for (const t of allParts[i]) {
			const prim = soup.triPrim[t];
			const list = byPrim.get(prim) ?? [];
			list.push(t);
			byPrim.set(prim, list);
		}
		parts.push({
			name: `part_${String(i).padStart(3, '0')}`,
			groups: [...byPrim.entries()].map(([primIndex, triangles]) => ({ primIndex, triangles })),
		});
		partColors.push(goldenAngleColor(i));
	}

	return { parts, partColors, warnings, totalComponents: solid.count };
}

/**
 * 同标签连通切分 + 逐轮小碎块合并（移植 maestro model_edit_segment.py:_connected_parts）。
 * 输入为实体内局部面号；返回合并后的局部面号分组。
 */
function connectedPartsWithMerge(
	nFaces: number,
	labels: Int32Array,
	adjacency: [number, number][],
	centers: Float64Array,
	minFaceCount: number,
): number[][] {
	// 同标签连通
	const uf = new UnionFind(nFaces);
	for (const [a, b] of adjacency) {
		if (labels[a] === labels[b]) uf.union(a, b);
	}
	const { compOf } = uf.compact();
	const mapping = Int32Array.from(compOf);

	// 逐轮合并小部件
	for (;;) {
		const nComp = nFaces;
		const sizes = new Int32Array(nComp);
		for (let i = 0; i < nFaces; i++) sizes[mapping[i]]++;
		const aliveIds: number[] = [];
		for (let c = 0; c < nComp; c++) if (sizes[c] > 0) aliveIds.push(c);
		const small = aliveIds.filter((c) => sizes[c] < minFaceCount);
		if (small.length === 0) break;

		// 跨部件共享边计数
		const shared = new Map<number, Map<number, number>>();
		for (const [a, b] of adjacency) {
			const ra = mapping[a];
			const rb = mapping[b];
			if (ra === rb) continue;
			const lo = Math.min(ra, rb);
			const hi = Math.max(ra, rb);
			let m = shared.get(lo);
			if (!m) {
				m = new Map();
				shared.set(lo, m);
			}
			m.set(hi, (m.get(hi) ?? 0) + 1);
			let m2 = shared.get(hi);
			if (!m2) {
				m2 = new Map();
				shared.set(hi, m2);
			}
			m2.set(lo, (m2.get(lo) ?? 0) + 1);
		}

		// 各部件质心
		const cent = new Float64Array(nComp * 3);
		for (let i = 0; i < nFaces; i++) {
			const c = mapping[i];
			cent[c * 3] += centers[i * 3];
			cent[c * 3 + 1] += centers[i * 3 + 1];
			cent[c * 3 + 2] += centers[i * 3 + 2];
		}
		for (const c of aliveIds) {
			cent[c * 3] /= sizes[c];
			cent[c * 3 + 1] /= sizes[c];
			cent[c * 3 + 2] /= sizes[c];
		}

		const merges = new Map<number, number>();
		const fallback: number[] = [];
		const resolve = (x: number): number => {
			let root = x;
			while (merges.has(root)) root = merges.get(root)!;
			return root;
		};
		for (const c of [...small].sort((x, y) => sizes[x] - sizes[y])) {
			let target = -1;
			let bestCount = -1;
			let bestSize = -1;
			for (const [nbr, cnt] of shared.get(c) ?? []) {
				const root = resolve(nbr);
				if (root === c) continue;
				if (cnt > bestCount || (cnt === bestCount && sizes[nbr] > bestSize)) {
					bestCount = cnt;
					bestSize = sizes[nbr];
					target = root;
				}
			}
			if (target >= 0) merges.set(c, target);
			else fallback.push(c);
		}

		// 悬空碎屑并入质心最近的「已达标注件」（避免碎屑互并成长链）
		if (fallback.length > 0) {
			const stable = aliveIds.filter((c) => !merges.has(c) && sizes[c] >= minFaceCount);
			const cand = stable.length > 0
				? stable
				: aliveIds.filter((c) => !merges.has(c));
			if (cand.length > 0) {
				for (const src of fallback) {
					let bestTgt = -1;
					let bestDist = Infinity;
					for (const tgt of cand) {
						if (tgt === src) continue;
						const dx = cent[src * 3] - cent[tgt * 3];
						const dy = cent[src * 3 + 1] - cent[tgt * 3 + 1];
						const dz = cent[src * 3 + 2] - cent[tgt * 3 + 2];
						const dist = dx * dx + dy * dy + dz * dz;
						if (dist < bestDist) {
							bestDist = dist;
							bestTgt = tgt;
						}
					}
					if (bestTgt >= 0) merges.set(src, bestTgt);
				}
			}
		}

		if (merges.size === 0) break;

		// 展平合并链（指针跳转到不动点）
		const flat = Int32Array.from({ length: nComp }, (_, i) => i);
		for (const [child, tgt] of merges) flat[child] = tgt;
		for (;;) {
			let changed = false;
			for (let i = 0; i < nComp; i++) {
				const stepped = flat[flat[i]];
				if (stepped !== flat[i]) {
					flat[i] = stepped;
					changed = true;
				}
			}
			if (!changed) break;
		}
		for (let i = 0; i < nFaces; i++) mapping[i] = flat[mapping[i]];
	}

	const grouped = new Map<number, number[]>();
	for (let i = 0; i < nFaces; i++) {
		const list = grouped.get(mapping[i]) ?? [];
		list.push(i);
		grouped.set(mapping[i], list);
	}
	return [...grouped.values()];
}

/** 黄金角互斥色相的部件预览色（对齐 maestro _part_color：hsv(h, 0.62, 0.92)）。 */
export function goldenAngleColor(index: number): [number, number, number] {
	const h = (index * 0.6180339887498949) % 1;
	const s = 0.62;
	const v = 0.92;
	const i = Math.floor(h * 6);
	const f = h * 6 - i;
	const p = v * (1 - s);
	const q = v * (1 - f * s);
	const t = v * (1 - (1 - f) * s);
	switch (i % 6) {
		case 0: return [v, t, p];
		case 1: return [q, v, p];
		case 2: return [p, v, t];
		case 3: return [p, q, v];
		case 4: return [t, p, v];
		default: return [v, p, q];
	}
}
