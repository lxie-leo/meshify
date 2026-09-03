/**
 * 双内核一致性（plan.md L281；无 uv 环境自动 skip）：
 * 同一输入 Tier0 与 Tier1 的 input 侧统计必须一致（顶点/面数/材质/贴图/bbox）。
 * kernel-py 输出的 manifest 同时被 zod 契约覆盖（contract.test.ts）。
 */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { readDocument, inspectDocument, stlToDocument } from '@meshify/kernel-ts';
import { resolveKernelPyDir, runPythonKernel, isKernelSynced } from '@meshify/core';
import { FIX, freshDir, hasUv } from './helpers';

const skip = () => !hasUv() || !isKernelSynced(resolveKernelPyDir());

/** Tier1 inspect 结果（无输出文件副作用）。 */
async function pyInspect(input: string) {
	const r = await runPythonKernel({ command: 'inspect', params: {}, input });
	expect(r.report.exit_code).toBe(0);
	return r.report.input;
}

async function tsInspect(input: string) {
	// 与 CLI loadInput 同口径：GLB/GLTF 走 NodeIO，STL 走自研读取器
	const doc = input.toLowerCase().endsWith('.stl')
		? stlToDocument(new Uint8Array(fs.readFileSync(input)), path.basename(input, '.stl'))
		: await readDocument(input);
	const r = await inspectDocument(doc);
	return r;
}

const numEq = (a: number | null | undefined, b: number | null | undefined, eps = 1e-4) =>
	(a ?? 0) - (b ?? 0) <= eps && (b ?? 0) - (a ?? 0) <= eps;

describe('Tier0 × Tier1 inspect 一致性', () => {
	it.skipIf(skip())('multimat.glb：顶点/面数/材质/贴图/逐子网格一致', async () => {
		const input = FIX('glb/multimat.glb');
		const [py, ts] = await Promise.all([pyInspect(input), tsInspect(input)]);
		expect(py.vertices).toBe(ts.vertices);
		expect(py.faces).toBe(ts.faces);
		expect(py.materials).toBe(ts.materials);
		expect(py.textures.length).toBe(ts.textures.length);
		expect(py.meshes.map((m: any) => m.faces)).toEqual(ts.meshes.map((m) => m.faces));
		expect(py.meshes.map((m: any) => m.has_uv)).toEqual(ts.meshes.map((m) => m.has_uv));
		for (let i = 0; i < 2; i++) {
			expect(numEq(py.bbox?.[0]?.[i], ts.bbox?.[0]?.[i])).toBe(true);
			expect(numEq(py.bbox?.[1]?.[i], ts.bbox?.[1]?.[i])).toBe(true);
		}
	}, 180_000);

	it.skipIf(skip())('dense.glb：单网格大模型一致', async () => {
		const input = FIX('glb/dense.glb');
		const [py, ts] = await Promise.all([pyInspect(input), tsInspect(input)]);
		expect(py.faces).toBe(ts.faces); // 5120
		expect(py.vertices).toBe(ts.vertices);
	}, 180_000);

	it.skipIf(skip())('STL（跨格式一致性）：面数一致', async () => {
		const input = FIX('stl/cube.stl');
		const [py, ts] = await Promise.all([pyInspect(input), tsInspect(input)]);
		expect(py.faces).toBe(ts.faces);
		expect(py.format).toBe('stl');
	}, 180_000);
});

describe('双内核行为等价（ratio = 保留率语义，双内核一致）', () => {
	it.skipIf(skip())('simplify ratio=0.3：双内核保留面数都在 30%±10%', async () => {
		const input = FIX('glb/dense.glb');
		const out = freshDir('consistency-simplify');
		const py = await runPythonKernel({
			command: 'simplify', params: { ratio: 0.3 }, input, output: path.join(out, 'py.glb'), overwrite: true,
		});
		expect(py.report.exit_code).toBe(0);
		const pyKeep = py.report.output!.faces / py.report.input.faces;
		expect(pyKeep).toBeGreaterThan(0.2);
		expect(pyKeep).toBeLessThan(0.4);

		const doc = await readDocument(input);
		const { simplifyDocument } = await import('@meshify/kernel-ts');
		const ts = await simplifyDocument(doc, { ratio: 0.3 });
		const tsKeep = ts.facesAfter / ts.facesBefore;
		expect(tsKeep).toBeGreaterThan(0.2);
		expect(tsKeep).toBeLessThan(0.4);
	}, 180_000);
});
