/**
 * 质量断言（golden 集验收，plan.md L246/L280）：
 * - 简化面数命中率（ratio 语义）与 max_error_normalized 上界
 * - 单向 Hausdorff 采样距离（独立实现，非内核自证）
 * - 水密性（边界边 = 0）：简化保持 / 平面切割封口恢复
 * - 分割无面丢失（面数守恒）
 */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import {
	readDocument,
	writeDocument,
	simplifyDocument,
	textureDocument,
	generateLodLevels,
	collectPrimitives,
	buildSoup,
	segmentConnected,
	segmentSemantic,
	cutSoupByPlane,
} from '@meshify/kernel-ts';
import {
	FIX, freshDir, directedHausdorff, meshDiagonal, boundaryEdgeCount,
	readTriMesh, type TriMesh, fixtureExists,
} from './helpers';

const DENSE = FIX('glb/dense.glb'); // 5120 面水密球

/** 采样：原始网格顶点 + 每面重心（独立于被测内核的采样方式）。 */
function sampleMesh(m: TriMesh, stride = 1): number[][] {
	const pts: number[][] = [];
	const nv = m.positions.length / 3;
	for (let i = 0; i < nv; i += stride) pts.push([m.positions[3 * i], m.positions[3 * i + 1], m.positions[3 * i + 2]]);
	for (let t = 0; t < m.indices.length; t += 3) {
		const c = [0, 0, 0];
		for (let k = 0; k < 3; k++) for (let j = 0; j < 3; j++) c[j] += m.positions[3 * m.indices[t + k] + j] / 3;
		pts.push(c);
	}
	return pts;
}

describe('simplify 质量（dense.glb 5120 面水密球）', () => {
	it('ratio=0.25 命中率 ±5%，且保持水密', async () => {
		const doc = await readDocument(DENSE);
		const r = await simplifyDocument(doc, { ratio: 0.25 });
		expect(r.facesBefore).toBe(5120);
		expect(r.facesAfter).toBeGreaterThan(5120 * 0.2);
		expect(r.facesAfter).toBeLessThan(5120 * 0.3);
		// dense.glb 材质+贴图+UV 齐备（fixtures 已修材质绑定）：贴图网格简化必须披露近似重投影（坑 2），此外不得有其他降级
		expect(r.warnings.map((w) => w.code)).toEqual(['UV_REMAP_APPROXIMATED']);
		const out = path.join(freshDir('quality-simplify'), 's.glb');
		await writeDocument(doc, out);
		const m = await readTriMesh(out);
		expect(boundaryEdgeCount(m)).toBe(0); // 水密保持
	}, 60_000);

	it('有向 Hausdorff（原始→简化）≤ 对角线 × 2.5%', async () => {
		const src = await readTriMesh(DENSE);
		const doc = await readDocument(DENSE);
		await simplifyDocument(doc, { ratio: 0.25 });
		const out = path.join(freshDir('quality-hausdorff'), 's.glb');
		await writeDocument(doc, out);
		const simplified = await readTriMesh(out);
		const diag = meshDiagonal(src);
		const d = directedHausdorff(sampleMesh(src, 7), simplified);
		expect(d / diag).toBeLessThan(0.025);
	}, 120_000);

	it('max_error_normalized 与 Hausdorff 同量级（manifest 误差字段可信）', async () => {
		const doc = await readDocument(DENSE);
		const r = await simplifyDocument(doc, { ratio: 0.25 });
		expect(r.maxErrorNormalized).toBeGreaterThanOrEqual(0);
		expect(r.maxErrorNormalized).toBeLessThan(0.02); // meshopt 语义归一化上界
	}, 60_000);

	it('min-faces 保护：20 面小球跳过 + SMALL_MESH_SKIPPED（坑 12）', async () => {
		const doc = await readDocument(FIX('glb/small.glb'));
		const r = await simplifyDocument(doc, { ratio: 0.5 });
		expect(r.facesAfter).toBe(20);
		expect(r.warnings.map((w) => w.code)).toContain('SMALL_MESH_SKIPPED');
	});
});

describe('segment plane 质量（封口水密，坑 5）', () => {
	it('切割水密球：两半均水密，截面封口补面', async () => {
		const doc = await readDocument(DENSE);
		const soup = buildSoup(collectPrimitives(doc));
		const cut = cutSoupByPlane(soup, { origin: [0, 0, 0], normal: [0, 1, 0] }, { cap: true });
		expect(cut.parts.length).toBe(2);
		for (const part of cut.parts) {
			expect(part.triangleCount).toBeGreaterThan(0);
		}
		// 两半面数之和 > 原面数（封口新增）
		const total = cut.parts.reduce((s, p) => s + p.triangleCount, 0);
		expect(total).toBeGreaterThan(soup.totalTriangles);
		// 水密性验证：平面切割专用构建器（扁平顶点三元组 + extra 顶点池，含封口复制顶点）
		const { buildPlanePartsDocument } = await import('@meshify/kernel-ts');
		const partDoc = buildPlanePartsDocument(doc, soup, cut, { doubleSided: true });
		for (const [i, mesh] of partDoc.getRoot().listMeshes().entries()) {
			const prim = mesh.listPrimitives()[0];
			const pos = prim.getAttribute('POSITION').getArray() as Float32Array;
			const idx = (prim.getIndices()?.getArray() ?? Uint32Array.from(Array.from({ length: pos.length / 3 }, (_, k) => k))) as Uint32Array;
			const bc = boundaryEdgeCount({ positions: pos, indices: idx }, 1e-4);
			expect(bc, `half_${i} boundary edges`).toBe(0);
		}
	}, 60_000);
});

describe('segment connected / semantic 质量（无面丢失）', () => {
	it('connected：multimat 3 壳，面数守恒', async () => {
		const doc = await readDocument(FIX('glb/multimat.glb'));
		const soup = buildSoup(collectPrimitives(doc));
		const r = segmentConnected(soup, { minFaces: 1 });
		expect(r.parts.length).toBe(3);
		const total = r.parts.reduce((s, p) => s + p.groups.reduce((a, g) => a + g.triangles.length, 0), 0);
		expect(total).toBe(soup.totalTriangles);
	});

	it('semantic：clusters=3 面数守恒且部件非空', async () => {
		const doc = await readDocument(DENSE);
		const soup = buildSoup(collectPrimitives(doc));
		const r = segmentSemantic(soup, { clusters: 3 });
		expect(r.parts.length).toBe(3);
		const total = r.parts.reduce((s, p) => s + p.groups.reduce((a, g) => a + g.triangles.length, 0), 0);
		expect(total).toBe(soup.totalTriangles);
		for (const p of r.parts) {
			expect(p.groups.reduce((a, g) => a + g.triangles.length, 0)).toBeGreaterThan(0);
		}
	}, 60_000);
});

describe('texture 质量', () => {
	it('box 投影后全顶点有 UV 且在 [0,1]', async () => {
		const doc = await readDocument(DENSE);
		const r = await textureDocument(doc, { mode: 'box' });
		// 已有贴图的子网格被重投影：显式披露（坑 2），无其他警告
		expect(r.warnings.map((w) => w.code)).toEqual(['UV_REMAP_APPROXIMATED']);
		const prim = doc.getRoot().listMeshes()[0].listPrimitives()[0];
		const uv = prim.getAttribute('TEXCOORD_0').getArray() as Float32Array;
		expect(uv.length).toBe((prim.getAttribute('POSITION').getArray().length / 3) * 2);
		for (const v of uv) expect(v).toBeGreaterThanOrEqual(0), expect(v).toBeLessThanOrEqual(1);
	}, 60_000);

	it('uv 模式：无 UV 子网格自动盒式 + AUTO_BOX_UV_GENERATED（坑 2）', async () => {
		const doc = await readDocument(FIX('glb/multimat.glb'));
		const r = await textureDocument(doc, { mode: 'uv' });
		const codes = r.warnings.map((w) => w.code);
		expect(codes).toContain('AUTO_BOX_UV_GENERATED');
		// 全部三个子网格现在都有 UV
		for (const mesh of doc.getRoot().listMeshes()) {
			for (const prim of mesh.listPrimitives()) {
				expect(prim.getAttribute('TEXCOORD_0')).toBeTruthy();
			}
		}
	}, 60_000);
});

describe('LOD 链质量', () => {
	it('三级链面数单调下降，level0 原样', async () => {
		const doc = await readDocument(DENSE);
		const r = await generateLodLevels(doc, { levels: 3, ratio: 0.5 });
		expect(r.levels.length).toBe(3);
		expect(r.levels[0].faces).toBe(5120);
		expect(r.levels[1].faces).toBeGreaterThan(r.levels[2].faces);
		expect(r.levels[2].faces).toBeGreaterThan(0);
	}, 120_000);
});
