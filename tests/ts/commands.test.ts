/** 单命令内核测试（kernel-ts 函数级）：inspect/convert/lod/optimize/guard。 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
	readDocument,
	inspectDocument,
	detectFormat,
	parseMtl,
	objToDocument,
	stlToDocument,
	assertResourceLimits,
} from '@meshify/kernel-ts';
import { FIX } from './helpers';

describe('inspect', () => {
	it('multimat.glb：3 子网格/3 材质/1 贴图/无 UV 子网格提示', async () => {
		const r = await inspectDocument(await readDocument(FIX('glb/multimat.glb')));
		expect(r.meshes).toHaveLength(3);
		expect(r.materials).toBe(3);
		expect(r.textures).toHaveLength(1);
		expect(r.vertices).toBe(72);
		expect(r.faces).toBe(36);
		expect(r.hints.missingUvs).toEqual(['plain_c']);
		expect(r.hasAnimation).toBe(false);
		// bbox（float32 精度内）：x ±1.7（textured_a 1.0 半宽 + 平移 1.2），y [-0.7, 1.0]（plain_c 半高 / textured_b 顶部）
		expect(r.bbox![0][0]).toBeCloseTo(-1.7, 5);
		expect(r.bbox![0][1]).toBeCloseTo(-0.7, 5);
		expect(r.bbox![0][2]).toBeCloseTo(-0.5, 5);
		expect(r.bbox![1][0]).toBeCloseTo(1.7, 5);
		expect(r.bbox![1][1]).toBeCloseTo(1.0, 5);
		expect(r.bbox![1][2]).toBeCloseTo(0.5, 5);
	});

	it('skin-anim.glb：动画/蒙皮识别', async () => {
		const r = await inspectDocument(await readDocument(FIX('glb/skin-anim.glb')));
		expect(r.hasAnimation).toBe(true);
		expect(r.faces).toBe(320);
	});

	it('open-shell.glb：开口壳无异常标记，面数 10', async () => {
		const r = await inspectDocument(await readDocument(FIX('glb/open-shell.glb')));
		expect(r.faces).toBe(10);
		expect(r.hints.smallMeshes.join(',')).toMatch(/open_shell/);
	});
});

describe('detectFormat（魔数嗅探）', () => {
	const cases: [string, string][] = [
		['glb/multimat.glb', 'glb'],
		['stl/cube.stl', 'stl'],
		['obj/two-material.obj', 'obj'],
		['step/cube.step', 'step'],
	];
	for (const [file, want] of cases) {
		it(`${file} → ${want}`, () => {
			const buf = fs.readFileSync(FIX(file)).subarray(0, 512);
			expect(detectFormat(new Uint8Array(buf), file)).toBe(want);
		});
	}

	it('未知二进制 → unknown', () => {
		expect(detectFormat(new Uint8Array([0x00, 0x01, 0x02, 0x03]), 'x.bin')).toBe('unknown');
	});
});

describe('OBJ 读取', () => {
	it('两材质 OBJ + MTL：材质数 2，顶点/面数正确，等价材质合并语义存在', () => {
		const dir = FIX('obj');
		const mtl = parseMtl(fs.readFileSync(path.join(dir, 'two-material.mtl'), 'utf8'));
		expect(mtl.size).toBe(2);
		expect(mtl.get('red_plastic')?.kd).toEqual([0.8, 0.1, 0.1]);
		expect(mtl.get('blue_plastic')?.ns).toBe(8);
		const r = objToDocument(fs.readFileSync(path.join(dir, 'two-material.obj'), 'utf8'), mtl, new Map());
		expect(r.materialCount).toBe(2);
		expect(r.doc.getRoot().listMeshes()).toHaveLength(2);
		const insp = r.doc.getRoot().listMeshes().map((m) => m.listPrimitives()[0]);
		const faces = insp.reduce((s, p) => s + (p.getIndices()?.getCount() ?? p.getAttribute('POSITION')?.getCount() ?? 0) / 3, 0);
		expect(faces).toBe(24); // 两盒 × 12
	});

	it('面引用负索引相对寻址', () => {
		const r = objToDocument('v 0 0 0\nv 1 0 0\nv 0 1 0\nf -3 -2 -1\n', null, new Map());
		expect(r.doc.getRoot().listMeshes()[0].listPrimitives()[0].getIndices()?.getCount()).toBe(3);
	});
});

describe('STL 读取', () => {
	it('二进制 STL：12 面、无材质、法线重算路径', () => {
		const doc = stlToDocument(fs.readFileSync(FIX('stl/cube.stl')), 'cube');
		const prim = doc.getRoot().listMeshes()[0].listPrimitives()[0];
		expect(prim.getIndices()?.getCount()).toBe(36);
		expect(prim.getAttribute('POSITION')?.getCount()).toBe(8); // 顶点焊接后 8 角点
	});
});

describe('资源防护（guard）', () => {
	it('面数超限抛出（exit 7 语义）', () => {
		expect(() => assertResourceLimits(1000, 6_000_000)).toThrowError(/faces/);
	});
	it('字节超限抛出', () => {
		expect(() => assertResourceLimits(600 * 1024 * 1024, 100)).toThrowError(/MB/);
	});
	it('force 显式覆盖放行', () => {
		expect(() => assertResourceLimits(600 * 1024 * 1024, 6_000_000, { force: true })).not.toThrow();
	});
	it('阈值内放行', () => {
		expect(() => assertResourceLimits(1024, 5120)).not.toThrow();
	});
});

describe('convert 内核（非 glTF → GLB 往返）', () => {
	it('STL → 文档 → inspect 三角形守恒', async () => {
		const doc = stlToDocument(fs.readFileSync(FIX('stl/cube.stl')), 'cube');
		const r = await inspectDocument(doc);
		expect(r.faces).toBe(12);
		expect(r.materials).toBe(0);
	});
});
