/**
 * 2026-09-17 skill 全量测试回归（4 项缺陷固化；修复前行为见各用例注释）。
 * 覆盖：lod -o 多级互相覆盖（只剩最后一级）、simplify 僵尸索引 accessor、
 * OBJ 缺 mtl 材质静默并入首名、Tier1 UV 接缝面数下限不写警告。
 */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { cli, FIX, freshDir, hasUv } from './helpers';
import { resolveKernelPyDir, isKernelSynced } from '@meshify/core';
import { objToDocument } from '@meshify/kernel-ts';

const TIER1 = () => hasUv() && isKernelSynced(resolveKernelPyDir());

/** 解析 GLB 的 JSON chunk（测试侧独立实现，不依赖内核读取路径）。 */
function glbJson(glbPath: string): Record<string, any> {
	const b = fs.readFileSync(glbPath);
	expect(b.readUInt32LE(0)).toBe(0x46546c67); // 'glTF' magic
	const jsonLen = b.readUInt32LE(12);
	return JSON.parse(b.subarray(20, 20 + jsonLen).toString('utf8'));
}

/** 未被任何 primitive 引用的 SCALAR accessor 数（僵尸索引计数）。 */
function zombieIndexAccessors(g: Record<string, any>): number {
	const used = new Set<number>();
	for (const m of g.meshes ?? []) for (const p of m.primitives ?? []) if (p.indices !== undefined) used.add(p.indices);
	return (g.accessors ?? []).filter((a: any, i: number) => a.type === 'SCALAR' && !used.has(i)).length;
}

// ------------------------------------------------------------------
// #2b：lod -o 多级输出（曾：explicit 下三级共用同一路径，只剩最后一级）
// ------------------------------------------------------------------
describe('skilltest 回归：lod -o 多级输出不互相覆盖', () => {
	it('三级链 -o → 三个文件、逐级面数递减、报告路径互异', () => {
		const dir = freshDir('skilltest-lod-o');
		const out = path.join(dir, 'chain.glb');
		const r = cli(['lod', FIX('glb/dense.glb'), '--levels', '3', '--ratio', '0.5', '-o', out, '--json']);
		expect(r.code).toBe(0);
		const levels = r.manifest?.metrics?.lod_levels ?? [];
		expect(levels).toHaveLength(3);
		// 报告路径互异（修复前三条路径完全相同）
		const paths = levels.map((l: any) => path.normalize(l.path));
		expect(new Set(paths).size).toBe(3);
		// 磁盘上三级俱在（修复前只剩 level2 一个文件）
		expect(fs.existsSync(out)).toBe(true);
		expect(fs.existsSync(path.join(dir, 'chain.lod1.glb'))).toBe(true);
		expect(fs.existsSync(path.join(dir, 'chain.lod2.glb'))).toBe(true);
		// 逐级面数 5120/2560/1280（dense fixture 固定拓扑）
		expect(levels.map((l: any) => l.faces)).toEqual([5120, 2560, 1280]);
	}, 120_000);
});

// ------------------------------------------------------------------
// #2a：simplify 换索引后旧 accessor 成为孤儿（曾：产物带全量原索引死数据）
// ------------------------------------------------------------------
describe('skilltest 回归：simplify 产物无僵尸索引 accessor', () => {
	it('dense 减半 → 无未被引用的 SCALAR accessor', () => {
		const dir = freshDir('skilltest-zombie');
		const out = path.join(dir, 'z.glb');
		const r = cli(['simplify', FIX('glb/dense.glb'), '--ratio', '0.5', '-o', out, '--json']);
		expect(r.code).toBe(0);
		expect(zombieIndexAccessors(glbJson(out))).toBe(0);
		// 面数确实减半（僵尸曾把文件撑到 ~89KB，干净产物 ~58KB）
		expect(r.manifest?.output?.faces).toBe(2560);
	}, 60_000);

	it('lod level1 同样干净（逐级深克隆路径共享同一 simplify 实现）', () => {
		const dir = freshDir('skilltest-zombie-lod');
		const out = path.join(dir, 'chain.glb');
		const r = cli(['lod', FIX('glb/dense.glb'), '--levels', '2', '-o', out, '--json']);
		expect(r.code).toBe(0);
		expect(zombieIndexAccessors(glbJson(path.join(dir, 'chain.lod1.glb')))).toBe(0);
	}, 120_000);
});

// ------------------------------------------------------------------
// #3：OBJ 缺 mtl（曾：所有 usemtl 名静默并入首名材质，零警告）
// ------------------------------------------------------------------
describe('skilltest 回归：OBJ 缺 mtl 按名保材质并披露', () => {
	it('objToDocument 无 mtl → 每名独立材质 + MTL_MISSING；有 mtl → 不误报', async () => {
		const text = fs.readFileSync(FIX('obj/two-material.obj'), 'utf8');
		const names = (text.match(/^usemtl .*$/gm) ?? []).map((s) => s.replace(/^usemtl /, ''));
		expect(new Set(names).size).toBeGreaterThanOrEqual(2); // fixture 前置：确有 ≥2 个名字

		const missing = objToDocument(text, null, new Map());
		expect(missing.materialCount).toBe(new Set(names).size); // 修复前：全部并入首名 = 1
		expect(missing.warnings.map((w) => w.code)).toContain('MTL_MISSING');

		const mtlText = fs.readFileSync(FIX('obj/two-material.mtl'), 'utf8');
		const { parseMtl } = await import('@meshify/kernel-ts');
		const present = objToDocument(text, parseMtl(mtlText), new Map());
		expect(present.warnings.map((w) => w.code)).not.toContain('MTL_MISSING');
	});

	it('CLI convert 缺失 mtllib → 警告 + 产物双材质 + inspect 归属正确', () => {
		const dir = freshDir('skilltest-mtl');
		const obj = path.join(dir, 'lost-mtl.obj');
		fs.writeFileSync(
			obj,
			fs.readFileSync(FIX('obj/two-material.obj'), 'utf8').replace(/^mtllib.*$/im, 'mtllib missing.mtl'),
		);
		const out = path.join(dir, 'o.glb');
		const r = cli(['convert', obj, '--to', 'glb', '-o', out, '--json']);
		expect(r.code).toBe(0);
		expect(r.manifest?.warnings?.map((w: any) => w.code)).toContain('MTL_MISSING');
		expect(glbJson(out).materials.map((m: any) => m.name).sort()).toEqual(['blue_plastic', 'red_plastic']);
		// inspect 侧材质归属随之正确（修复前第二个网格被报成首名材质）
		const insp = cli(['inspect', out, '--json']);
		const mats = insp.manifest?.input?.meshes?.map((m: any) => m.material);
		expect(new Set(mats).size).toBe(2);
	}, 60_000);
});

// ------------------------------------------------------------------
// #4：Tier1 UV 接缝面数下限要写警告（曾：请求 102 实得 476，零警告）
// ------------------------------------------------------------------
describe('skilltest 回归：Tier1 UV 接缝地板披露', () => {
	/** 最小纯色 PNG（8bit RGB，无依赖手写编码）。 */
	function tinyPng(): Buffer {
		const W = 4, H = 4;
		const raw = Buffer.alloc(H * (1 + W * 3));
		for (let y = 0; y < H; y++) {
			raw[y * (1 + W * 3)] = 0;
			for (let x = 0; x < W; x++) raw.fill(0xcc, y * (1 + W * 3) + 1 + x * 3, y * (1 + W * 3) + 4 + x * 3);
		}
		const chunk = (type: string, data: Buffer) => {
			const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
			const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
			const tbl = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; tbl[n] = c >>> 0; }
			let crc = 0xffffffff; for (const b of td) crc = tbl[(crc ^ b) & 0xff] ^ (crc >>> 8);
			const crcB = Buffer.alloc(4); crcB.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
			return Buffer.concat([len, td, crcB]);
		};
		const ihdr = Buffer.alloc(13);
		ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
		return Buffer.concat([
			Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
			chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
		]);
	}

	it.runIf(TIER1())(
		'先贴图（盒式分岛）后深减面 → UV_SEAM_DECIMATION_LIMITED + 实际面数高于目标；原始输入不误报',
		async () => {
			const dir = freshDir('skilltest-seam');
			const png = path.join(dir, 'tex.png');
			fs.writeFileSync(png, tinyPng());
			const textured = path.join(dir, 't1.glb');
			const tex = cli(['texture', FIX('glb/dense.glb'), '--map', 'box', '--image', png, '-o', textured, '--json']);
			expect(tex.code).toBe(0);

			const out = path.join(dir, 's.glb');
			const r = cli(['simplify', textured, '--ratio', '0.02', '--tier', 'py', '-o', out, '--json']);
			expect(r.code).toBe(0);
			expect(r.manifest?.warnings?.map((w: any) => w.code)).toContain('UV_SEAM_DECIMATION_LIMITED');
			// 下限为真：实际面数显著高于请求目标（5120×0.02≈102）
			expect(r.manifest?.output?.faces).toBeGreaterThan(120);

			// 对照：未分岛的原始 dense 深减面不误报（无贴图接缝可顶）
			const ctl = path.join(dir, 'c.glb');
			const rc = cli(['simplify', FIX('glb/dense.glb'), '--ratio', '0.02', '--tier', 'py', '-o', ctl, '--json']);
			expect(rc.code).toBe(0);
			expect(rc.manifest?.warnings?.map((w: any) => w.code)).not.toContain('UV_SEAM_DECIMATION_LIMITED');
		},
		240_000,
	);
});
