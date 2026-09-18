/**
 * 2026-09-18 多轮对抗测试回归（本轮 4 项缺陷/缺陷群固化；修复前行为见各用例注释）。
 * 覆盖：输出目录被同名文件占用（曾裸 ENOTDIR 栈 + exit 8）、报告路径被目录占用时
 * stdout manifest 丢失（曾 writeReportFile 先炸）、LOD 级别数变少残留文件不披露、
 * STEP --resolution 未接 CLI（py 内核早已支持）、convert --help 文案 "(required)" 误导。
 */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { cli, FIX, freshDir, hasUv } from './helpers';
import { resolveKernelPyDir, isKernelSynced } from '@meshify/core';

const TIER1 = () => hasUv() && isKernelSynced(resolveKernelPyDir());

const warnCodes = (r: { manifest: Record<string, any> | null }) =>
	(r.manifest?.warnings ?? []).map((w: any) => w.code);

// ------------------------------------------------------------------
// B1a：输出目录被同名常规文件占用（曾：fs.mkdirSync 裸 ENOTDIR 栈，exit 8 无 manifest）
// ------------------------------------------------------------------
describe('audit2 回归：输出目录被文件占用 → exit 4 + manifest', () => {
	it('默认布局 <input>.meshify 是常规文件 → exit 4 友好诊断 + 最小失败 manifest', () => {
		const dir = freshDir('audit2-dir-occupied');
		const input = path.join(dir, 'm.glb');
		fs.copyFileSync(FIX('glb/small.glb'), input);
		fs.writeFileSync(path.join(dir, 'm.meshify'), 'x');
		const r = cli(['simplify', input, '--ratio', '0.5', '--json']);
		expect(r.code).toBe(4);
		expect(r.stderr).toMatch(/occupied by a regular file/i);
		// 「非 0 退出也落 manifest」是全路径协议：目录建不起来也不例外
		expect(r.manifest?.exit_code).toBe(4);
		expect((r.manifest?.errors ?? []).join(' ')).toMatch(/occupied by a regular file/i);
		// 占位文件原封不动（失败路径绝不写产物）
		expect(fs.readFileSync(path.join(dir, 'm.meshify'), 'utf8')).toBe('x');
	});

	it('显式 -o 的父级组件是常规文件 → 同样 exit 4 + manifest', () => {
		const dir = freshDir('audit2-dir-occupied-o');
		fs.writeFileSync(path.join(dir, 'blocker'), 'x');
		const r = cli(['simplify', FIX('glb/small.glb'), '--ratio', '0.5', '-o', path.join(dir, 'blocker', 'out.glb'), '--json']);
		expect(r.code).toBe(4);
		expect(r.stderr).toMatch(/occupied by a regular file/i);
		expect(r.manifest?.exit_code).toBe(4);
	});
});

// ------------------------------------------------------------------
// B1b：报告文件路径被目录占用（曾：writeReportFile 先于 stdout 抛出，--json 下 stdout 空）
// ------------------------------------------------------------------
describe('audit2 回归：报告路径被目录占用 → exit 8 但 stdout manifest 保住', () => {
	it('simplify 成功但报告写不进 → stdout 仍有可解析 manifest（errors 说明原因）', () => {
		const dir = freshDir('audit2-report-as-dir');
		const input = path.join(dir, 'm.glb');
		fs.copyFileSync(FIX('glb/small.glb'), input);
		fs.mkdirSync(path.join(dir, 'm.meshify', 'm.simplified.report.json'), { recursive: true });
		const r = cli(['simplify', input, '--ratio', '0.5', '--json']);
		// 报告落盘失败属内部错误（exit 8），但 stdout 协议必须活着：Agent 先解析 stdout
		expect(r.code).toBe(8);
		expect(r.manifest).not.toBeNull();
		expect(r.manifest?.exit_code).toBe(8);
		expect((r.manifest?.errors ?? []).length).toBeGreaterThan(0);
	});
});

// ------------------------------------------------------------------
// B2：LOD 级别数变少重跑，目录里残留上次的更高级别文件（曾：静默残留，glob 收产物的下游会多收）
// ------------------------------------------------------------------
describe('audit2 回归：LOD 残留级别披露 STALE_LOD_LEVELS（Tier0）', () => {
	it('5 级后重跑 3 级 → 警告点名 lod3/lod4，残留文件不动、manifest 只描述本次 3 级', () => {
		const dir = freshDir('audit2-stale-lod');
		const input = path.join(dir, 'm.glb');
		fs.copyFileSync(FIX('glb/dense.glb'), input);
		expect(cli(['lod', input, '--levels', '5', '--json']).code).toBe(0);
		const r = cli(['lod', input, '--levels', '3', '--overwrite', '--json']);
		expect(r.code).toBe(0);
		expect(warnCodes(r)).toContain('STALE_LOD_LEVELS');
		const w = (r.manifest?.warnings ?? []).find((x: any) => x.code === 'STALE_LOD_LEVELS');
		// 点名残留文件 + 申明 manifest 只描述本次产物
		expect(w.message).toMatch(/m\.lod3\.glb/);
		expect(w.message).toMatch(/m\.lod4\.glb/);
		expect(w.message).toMatch(/describes only the 3/);
		// 披露而非删除：残留文件仍在盘上；本次 files[] 只含 3 级（+报告）
		expect(fs.existsSync(path.join(dir, 'm.meshify', 'm.lod3.glb'))).toBe(true);
		expect(fs.existsSync(path.join(dir, 'm.meshify', 'm.lod4.glb'))).toBe(true);
		expect((r.manifest?.metrics?.lod_levels ?? []).length).toBe(3);
		const listed = (r.manifest?.output?.files ?? []).map((f: any) => path.basename(f.path));
		expect(listed.filter((n: string) => /\.lod\d+\.glb$/.test(n)).sort()).toEqual(['m.lod0.glb', 'm.lod1.glb', 'm.lod2.glb']);
	}, 240_000);

	it('重跑同级别数（3 → 3）→ 无 STALE_LOD_LEVELS（不误报）', () => {
		const dir = freshDir('audit2-stale-lod-same');
		const input = path.join(dir, 'm.glb');
		fs.copyFileSync(FIX('glb/dense.glb'), input);
		expect(cli(['lod', input, '--levels', '3', '--json']).code).toBe(0);
		const r = cli(['lod', input, '--levels', '3', '--overwrite', '--json']);
		expect(r.code).toBe(0);
		expect(warnCodes(r)).not.toContain('STALE_LOD_LEVELS');
	}, 240_000);
});

describe('audit2 回归：LOD 残留级别披露 STALE_LOD_LEVELS（Tier1）', () => {
	it.skipIf(!TIER1())(
		'py 5 级后重跑 3 级 → 同一警告（part_003/part_004 残留）',
		() => {
			const dir = freshDir('audit2-stale-lod-py');
			const input = path.join(dir, 'm.glb');
			fs.copyFileSync(FIX('glb/dense.glb'), input);
			expect(cli(['lod', input, '--levels', '5', '--tier', 'py', '--json']).code).toBe(0);
			const r = cli(['lod', input, '--levels', '3', '--tier', 'py', '--overwrite', '--json']);
			expect(r.code).toBe(0);
			expect(warnCodes(r)).toContain('STALE_LOD_LEVELS');
			const w = (r.manifest?.warnings ?? []).find((x: any) => x.code === 'STALE_LOD_LEVELS');
			expect(w.message).toMatch(/part_003\.glb/);
			// py 输出布局：<stem>.meshify/<stem>.lod/part_%03d.glb
			expect(fs.existsSync(path.join(dir, 'm.meshify', 'm.lod', 'part_004.glb'))).toBe(true);
		},
		360_000,
	);
});

// ------------------------------------------------------------------
// D1：STEP --resolution 接线（py 内核早已支持，CLI 曾未传参 → 恒默认 100）
// ------------------------------------------------------------------
describe('audit2 回归：STEP --resolution 生效（inspect/convert）', () => {
	it.runIf(TIER1())(
		'inspect --resolution 30 比 60 更粗（面更少），params 回显',
		() => {
			const coarse = cli(['inspect', FIX('step/holed-base.step'), '--resolution', '30', '--json']);
			expect(coarse.code).toBe(0);
			expect(coarse.manifest?.params?.resolution).toBe(30);
			const fine = cli(['inspect', FIX('step/holed-base.step'), '--resolution', '60', '--json']);
			expect(fine.code).toBe(0);
			// holed-base 含圆柱孔：目标边长 = 对角线/n，粗网格必须面更少（修复前两值恒同）
			expect(coarse.manifest?.input?.faces).toBeLessThan(fine.manifest?.input?.faces);
		},
		240_000,
	);

	it.runIf(TIER1())(
		'convert --to glb --resolution 30 → params 回显 + 产物面数 > 0',
		() => {
			const dir = freshDir('audit2-resolution-convert');
			const copy = path.join(dir, 'c.step');
			fs.copyFileSync(FIX('step/cube.step'), copy);
			const r = cli(['convert', copy, '--to', 'glb', '--resolution', '30', '--json']);
			expect(r.code).toBe(0);
			expect(r.manifest?.params?.resolution).toBe(30);
			expect(r.manifest?.output?.faces).toBeGreaterThan(0);
		},
		180_000,
	);

	it('非 STEP 输入传 --resolution → exit 4（inspect 与 convert 都拒绝）', () => {
		const r1 = cli(['inspect', FIX('glb/small.glb'), '--resolution', '50']);
		expect(r1.code).toBe(4);
		expect(r1.stderr).toMatch(/--resolution only applies to STEP/);
		const r2 = cli(['convert', FIX('glb/small.glb'), '--to', 'stl', '--resolution', '30']);
		expect(r2.code).toBe(4);
		expect(r2.stderr).toMatch(/--resolution only applies to STEP/);
	});

	it('越界/非整数值 → exit 4', () => {
		expect(cli(['convert', FIX('step/cube.step'), '--resolution', '0']).code).toBe(4);
		expect(cli(['inspect', FIX('step/cube.step'), '--resolution', '100001']).code).toBe(4);
		expect(cli(['inspect', FIX('step/cube.step'), '--resolution', '1.5']).code).toBe(4);
	});
});

// ------------------------------------------------------------------
// B3：convert --to 文案（曾标 "(required)"，实际缺省 glb——误导调用方以为必传）
// ------------------------------------------------------------------
describe('audit2 回归：convert --help 不再标注 (required)', () => {
	it('--to 有缺省值，help 不得出现 (required)', () => {
		const r = cli(['convert', '--help']);
		expect(r.code).toBe(0);
		expect(r.stdout + r.stderr).not.toMatch(/\(required\)/);
	});
});
