/**
 * 2026-09-03 全量测试回归（6 BUG + 观察项修复固化）。
 * 覆盖：optimize stdout 纯净（Logger）、PLY face 额外属性、空场景 convert、
 * OBJ 二进制冒充披露、多 scene 孤儿几何面数守恒（双内核）、py lod 非 glb 输入、
 * py plane 封口（networkx）、py gltf 贴图去重。
 */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { cli, FIX, freshDir, hasUv } from './helpers';
import { resolveKernelPyDir, isKernelSynced } from '@meshify/core';
import { plyToDocument } from '@meshify/kernel-ts';

const TIER1 = () => hasUv() && isKernelSynced(resolveKernelPyDir());

// ------------------------------------------------------------------
// BUG ①：optimize --json 时 stdout 只能有 manifest（gltf-transform 库级
// info 日志曾把 "prune: ..." 混进 stdout 污染解析）
// ------------------------------------------------------------------
describe('全量回归：--json stdout 纯净', () => {
	it('optimize --json：stdout 整体可 JSON.parse（无库日志前缀/混入）', () => {
		const dir = freshDir('fr-optjson');
		const r = cli(['optimize', FIX('glb/multimat.glb'), '-o', path.join(dir, 'o.glb'), '--json']);
		expect(r.code).toBe(0);
		expect(() => JSON.parse(r.stdout)).not.toThrow(); // 整体解析，不接受「跳过前缀垃圾」
		const manifest = JSON.parse(r.stdout);
		expect(manifest.schema).toBe('meshify.report/v1');
		expect(manifest.command).toBe('optimize');
	}, 120_000);
});

// ------------------------------------------------------------------
// BUG ⑤：二进制 PLY face 元素带额外属性（trimesh 导出的 `stl` ushort）——
// 读取器不消费会字节错位，曾把 12 面静默读成 4 面
// ------------------------------------------------------------------
describe('全量回归：PLY face 额外属性', () => {
	it('binary PLY face 带 ushort stl 属性 → 12 面全量读出', () => {
		const header = [
			'ply',
			'format binary_little_endian 1.0',
			'element vertex 8',
			'property float x',
			'property float y',
			'property float z',
			'element face 12',
			'property list uchar int vertex_indices',
			'property ushort stl',
			'end_header',
			'',
		].join('\n');
		const buf = Buffer.alloc(Buffer.byteLength(header) + 8 * 12 + 12 * (1 + 3 * 4 + 2));
		buf.write(header, 0, 'ascii');
		let o = Buffer.byteLength(header);
		// 8 顶点：单位立方体
		for (const [x, y, z] of [[0,0,0],[1,0,0],[1,1,0],[0,1,0],[0,0,1],[1,0,1],[1,1,1],[0,1,1]]) {
			buf.writeFloatLE(x, o); buf.writeFloatLE(y, o + 4); buf.writeFloatLE(z, o + 8); o += 12;
		}
		// 12 面（六面体拆三角），每面记录 = cnt(1B) + 3×idx(4B) + stl(2B)
		const quads = [[0,3,2,1],[4,5,6,7],[0,1,5,4],[2,3,7,6],[0,4,7,3],[1,2,6,5]];
		for (const q of quads) {
			for (const [a, b, c] of [[q[0], q[1], q[2]], [q[0], q[2], q[3]]]) {
				buf.writeUInt8(3, o); o += 1;
				buf.writeInt32LE(a, o); buf.writeInt32LE(b, o + 4); buf.writeInt32LE(c, o + 8); o += 12;
				buf.writeUInt16LE(0, o); o += 2; // 额外 stl 属性（修复前导致错位）
			}
		}
		const doc = plyToDocument(new Uint8Array(buf), 'extra-prop');
		let faces = 0;
		for (const mesh of doc.getRoot().listMeshes()) {
			for (const prim of mesh.listPrimitives()) faces += (prim.getIndices()?.getCount() ?? 0) / 3;
		}
		expect(faces).toBe(12); // 修复前：字节错位只读出 4 面
	});
});

// ------------------------------------------------------------------
// BUG ⑥：空场景 convert 产出合法空产物（读回校验曾把 stl/ply 路径误报 exit 8）
// ------------------------------------------------------------------
describe('全量回归：空场景 convert', () => {
	for (const to of ['stl', 'ply', 'obj', 'gltf']) {
		it(`empty.glb --to ${to} → 0 + EMPTY_SCENE_OUTPUT 披露`, () => {
			const dir = freshDir('fr-empty-' + to);
			const out = path.join(dir, 'e.' + to);
			const r = cli(['convert', FIX('glb/empty.glb'), '--to', to, '-o', out, '--json']);
			expect(r.code).toBe(0);
			expect(fs.existsSync(out)).toBe(true);
			expect(r.manifest?.output?.faces).toBe(0);
			expect((r.manifest?.warnings ?? []).map((w: any) => w.code)).toContain('EMPTY_SCENE_OUTPUT');
		});
	}

	it.runIf(TIER1())(
		'empty.glb --to stl --tier py → 0 + EMPTY_SCENE_OUTPUT（trimesh 拒绝空 Scene 曾崩）',
		() => {
			const dir = freshDir('fr-empty-py');
			const out = path.join(dir, 'e.stl');
			const r = cli(['convert', FIX('glb/empty.glb'), '--to', 'stl', '--tier', 'py', '-o', out, '--json']);
			expect(r.code).toBe(0);
			expect(fs.existsSync(out)).toBe(true);
			expect((r.manifest?.warnings ?? []).map((w: any) => w.code)).toContain('EMPTY_SCENE_OUTPUT');
		},
		180_000,
	);
});

// ------------------------------------------------------------------
// 观察项 ⑧：二进制内容冒充 .obj → FORMAT_CONTENT_MISMATCH 披露（不再静默空结果）
// ------------------------------------------------------------------
describe('全量回归：OBJ 扩展名冒充', () => {
	it('STL 字节改名为 .obj → inspect 警告 FORMAT_CONTENT_MISMATCH', () => {
		const dir = freshDir('fr-fakeobj');
		const f = path.join(dir, 'fake.obj');
		fs.copyFileSync(FIX('stl/cube.stl'), f);
		const r = cli(['inspect', f, '--json']);
		expect(r.code).toBe(0);
		expect((r.manifest?.warnings ?? []).map((w: any) => w.code)).toContain('FORMAT_CONTENT_MISMATCH');
	});
});

// ------------------------------------------------------------------
// BUG ②：多 scene GLB 的孤儿几何——Tier1 曾静默丢子网格（12/36 面）；
// Tier0 全量保留。修复后双内核面数守恒 + ORPHAN_GEOMETRY_ATTACHED 披露
// ------------------------------------------------------------------
describe('全量回归：多 scene 孤儿几何面数守恒', () => {
	it('Tier0：multiscene.glb --to stl → 332 面（12 盒 + 320 球全保留）', () => {
		const dir = freshDir('fr-ms-ts');
		const out = path.join(dir, 'ms.stl');
		const r = cli(['convert', FIX('glb/multiscene.glb'), '--to', 'stl', '-o', out, '--json']);
		expect(r.code).toBe(0);
		expect(r.manifest?.output?.faces).toBe(332);
	});

	it.runIf(TIER1())(
		'Tier1：multiscene.glb --to stl → 332 面 + ORPHAN_GEOMETRY_ATTACHED（曾丢到 12 面）',
		() => {
			const dir = freshDir('fr-ms-py');
			const out = path.join(dir, 'ms.stl');
			const r = cli(['convert', FIX('glb/multiscene.glb'), '--to', 'stl', '--tier', 'py', '-o', out, '--json']);
			expect(r.code).toBe(0);
			expect(r.manifest?.output?.faces).toBe(332);
			expect((r.manifest?.warnings ?? []).map((w: any) => w.code)).toContain('ORPHAN_GEOMETRY_ATTACHED');
		},
		180_000,
	);
});

// ------------------------------------------------------------------
// BUG ③：py lod 非 glb 输入——part_000 曾是字节直拷的假 GLB（.obj 改名）
// ------------------------------------------------------------------
describe('全量回归：py lod 非 glb 输入', () => {
	it.runIf(TIER1())(
		'OBJ 输入 → part_000.glb 是合法 GLB（magic glTF）',
		() => {
			const dir = freshDir('fr-lod-py');
			fs.mkdirSync(dir, { recursive: true });
			const r = cli(['lod', FIX('obj/two-material.obj'), '--levels', '2', '--tier', 'py', '-o', dir, '--json']);
			expect(r.code).toBe(0);
			const p0 = (r.manifest?.metrics?.lod_levels ?? [])[0]?.path;
			expect(p0 && fs.existsSync(p0)).toBe(true);
			expect(fs.readFileSync(p0).subarray(0, 4).toString('ascii')).toBe('glTF');
		},
		180_000,
	);
});

// ------------------------------------------------------------------
// BUG ④：py plane 封口依赖 networkx（enclosure_tree）——曾缺依赖直接崩
// ------------------------------------------------------------------
describe('全量回归：py plane 封口', () => {
	it.runIf(TIER1())(
		'segment --mode plane（默认 cap）→ exit 0，封口面数守恒',
		() => {
			const dir = freshDir('fr-plane-py');
			const r = cli(['segment', FIX('stl/cube.stl'), '--mode', 'plane', '--axis', 'x', '--position', '0', '--tier', 'py', '-o', dir, '--json']);
			expect(r.code).toBe(0);
			const parts = r.manifest?.metrics?.parts ?? [];
			expect(parts.length).toBe(2);
			expect(parts.reduce((s: number, p: any) => s + p.faces, 0)).toBeGreaterThanOrEqual(12); // 原面全保留 + 封口新增
		},
		180_000,
	);
});

// ------------------------------------------------------------------
// 观察项 ⑩：py gltf 导出共享贴图去重（同 PNG 曾逐引用重复内嵌）
// ------------------------------------------------------------------
describe('全量回归：py gltf 贴图去重', () => {
	it.runIf(TIER1())(
		'multimat.glb --to gltf --tier py → 共享贴图只出现一个 image 条目',
		() => {
			const dir = freshDir('fr-dedup-py');
			const out = path.join(dir, 'mm.gltf');
			const r = cli(['convert', FIX('glb/multimat.glb'), '--to', 'gltf', '--tier', 'py', '-o', out, '--json']);
			expect(r.code).toBe(0);
			const doc = JSON.parse(fs.readFileSync(out, 'utf-8'));
			const images = doc.images ?? [];
			expect(images.length).toBe(1); // mat_A/mat_B 共享同一 checker PNG
		},
		180_000,
	);
});
