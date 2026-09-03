/**
 * E2E（CLI 全链路）：inspect → simplify → 读报告 → 输出布局 → 预览页。
 * 模拟 Agent 视角：只看 stdout manifest + 退出码 + 磁盘产物。
 */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { cli, FIX, freshDir, fixtureExists } from './helpers';

describe('Agent 工作流 E2E', () => {
	it('inspect → simplify → 报告可解析、指标自洽', () => {
		const dir = freshDir('e2e-basic');
		const input = FIX('glb/dense.glb');
		const copy = path.join(dir, 'dense.glb');
		fs.copyFileSync(input, copy);

		const insp = cli(['inspect', copy, '--json']);
		expect(insp.code).toBe(0);
		const inFaces = insp.manifest!.input.faces;

		const simp = cli(['simplify', copy, '--ratio', '0.25', '--json', '--overwrite']);
		expect(simp.code).toBe(0);
		const m = simp.manifest!;
		expect(m.input.faces).toBe(inFaces);
		expect(m.output.faces).toBeLessThan(inFaces);
		// 指标自洽：face_reduction = 1 - out/in
		expect(m.metrics.face_reduction).toBeCloseTo(1 - m.output.faces / m.input.faces, 5);
		// 产物真实存在且字节数与 manifest 一致
		const asset = m.output.files.find((f: any) => f.role === 'asset');
		expect(asset).toBeTruthy();
		expect(fs.statSync(asset.path).size).toBe(asset.bytes);
	}, 120_000);

	it('.meshify/ 默认输出布局 + report.json 落盘', () => {
		const dir = freshDir('e2e-layout');
		const copy = path.join(dir, 'model.glb');
		fs.copyFileSync(FIX('glb/multimat.glb'), copy);
		const r = cli(['simplify', copy, '--ratio', '0.5', '--json']);
		expect(r.code).toBe(0);
		// 布局：<inputDir>/<name>.meshify/<name>.simplified.<ext> + <name>.simplified.report.json
		const meshifyDir = path.join(dir, 'model.meshify');
		expect(fs.existsSync(meshifyDir)).toBe(true);
		expect(fs.existsSync(path.join(meshifyDir, 'model.simplified.glb'))).toBe(true);
		expect(fs.existsSync(path.join(meshifyDir, 'model.simplified.report.json'))).toBe(true);
		const onDisk = JSON.parse(fs.readFileSync(path.join(meshifyDir, 'model.simplified.report.json'), 'utf8'));
		expect(onDisk.schema).toBe('meshify.report/v1');
		expect(onDisk.exit_code).toBe(0);
		// 源文件绝不被改动
		expect(fs.statSync(copy).size).toBe(fs.statSync(FIX('glb/multimat.glb')).size);
	}, 120_000);

	it('重复执行同命令 → exit 4（幂等安全）', () => {
		const dir = freshDir('e2e-idempotent');
		const copy = path.join(dir, 'model.glb');
		fs.copyFileSync(FIX('glb/small.glb'), copy);
		const first = cli(['simplify', copy, '--ratio', '0.5']);
		expect(first.code).toBe(0);
		const second = cli(['simplify', copy, '--ratio', '0.5']);
		expect(second.code).toBe(4);
	}, 120_000);

	it('--preview-html 生成自包含对比页（含双视窗与指标面板）', () => {
		const dir = freshDir('e2e-preview');
		const copy = path.join(dir, 'model.glb');
		fs.copyFileSync(FIX('glb/dense.glb'), copy);
		const r = cli(['simplify', copy, '--ratio', '0.5', '--preview-html', '--json', '--overwrite']);
		expect(r.code).toBe(0);
		const preview = r.manifest!.output.files.find((f: any) => f.role === 'preview');
		expect(preview).toBeTruthy();
		const html = fs.readFileSync(preview.path, 'utf8');
		// 数据注入完成：无未替换 token（__DATA__ / __THREE_VERSION__）
		expect(html.match(/__(?:DATA|THREE_VERSION)__/g) ?? []).toEqual([]);
		// 双视窗标签（BEFORE 原始 / AFTER 产物）
		expect(html).toContain('BEFORE · 原始');
		expect(html).toContain('AFTER · 产物');
		expect(html.length).toBeGreaterThan(10_000); // base64 模型内嵌
	}, 120_000);

	it('segment --mode plane 产出多部件 + 部件指标', () => {
		const dir = freshDir('e2e-plane');
		const copy = path.join(dir, 'dense.glb');
		fs.copyFileSync(FIX('glb/dense.glb'), copy);
		const r = cli(['segment', copy, '--mode', 'plane', '--axis', 'y', '--position', '0', '--json']);
		expect(r.code).toBe(0);
		const m = r.manifest!;
		// Tier0：单 GLB 多节点；部件明细在 metrics.parts
		expect(m.metrics.parts.length).toBe(2);
		for (const p of m.metrics.parts) expect(p.faces).toBeGreaterThan(0);
		const asset = m.output.files.find((f: any) => f.role === 'asset');
		expect(asset).toBeTruthy();
		expect(fs.existsSync(asset.path)).toBe(true);
	}, 120_000);

	it('lod 多级产物 + optimize meshopt 往返可读', () => {
		const dir = freshDir('e2e-lod-opt');
		const lodIn = path.join(dir, 'dense.glb');
		fs.copyFileSync(FIX('glb/dense.glb'), lodIn);
		const lod = cli(['lod', lodIn, '--levels', '3', '--ratio', '0.5', '--json']);
		expect(lod.code).toBe(0);
		const lods = lod.manifest!.output.files.filter((f: any) => f.role === 'lod');
		expect(lods.length).toBe(3);
		expect(lod.manifest!.metrics.lod_levels.map((l: any) => l.faces)).toEqual([5120, 2560, 1280]);

		const opt = cli(['optimize', FIX('glb/multimat.glb'), '-o', path.join(dir, 'opt.glb'), '--json', '--overwrite']);
		expect(opt.code).toBe(0);
		// 优化产物可再次 inspect（合法 GLB）
		const re = cli(['inspect', path.join(dir, 'opt.glb'), '--json']);
		expect(re.code).toBe(0);
		expect(re.manifest!.input.meshes.length).toBe(3);
	}, 180_000);

	it('doctor --json 输出环境探测（自有 JSON 形态，非 manifest）', () => {
		const r = cli(['doctor', '--json']);
		expect(r.code).toBe(0);
		const m = r.manifest!;
		expect(m.tool?.name).toBe('meshify');
		expect(typeof m.time).toBe('string');
	}, 60_000);
});
