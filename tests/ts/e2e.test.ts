/**
 * E2E（CLI 全链路）：inspect → simplify → 读报告 → 输出布局 → 预览页。
 * 模拟 Agent 视角：只看 stdout manifest + 退出码 + 磁盘产物。
 */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { cli, FIX, freshDir, fixtureExists, hasUv } from './helpers';

describe('Agent 工作流 E2E', () => {
	/** 读 GLB 的 accessor min/max，聚合出全场景包围盒（验证朝向/尺度用） */
	function glbAccessorBounds(glbPath: string): [number[], number[]] {
		const buf = fs.readFileSync(glbPath);
		const jsonLen = buf.readUInt32LE(12);
		const gltf = JSON.parse(buf.slice(20, 20 + jsonLen).toString('utf8'));
		const lo = [Infinity, Infinity, Infinity];
		const hi = [-Infinity, -Infinity, -Infinity];
		for (const acc of gltf.accessors as any[]) {
			if (!acc.min || !acc.max || acc.min.length !== 3) continue;
			for (let k = 0; k < 3; k++) {
				lo[k] = Math.min(lo[k], acc.min[k]);
				hi[k] = Math.max(hi[k], acc.max[k]);
			}
		}
		return [lo, hi];
	}

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
		// 双视窗标签（BEFORE input / AFTER output）
		expect(html).toContain('BEFORE · input');
		expect(html).toContain('AFTER · output');
	// 相机纵横比随视窗同步（缺了会在宽视窗下横向拉伸，旋转时呈「哈哈镜」变形）
		expect(html).toContain('updateProjectionMatrix');
	// 地面网格按模型尺度生成 + 接地阴影（缺了模型悬空无参照，旋转迷向）
		expect(html).toContain('groundAndShadow');
		expect(html).toContain('ShadowMaterial');
		expect(html.length).toBeGreaterThan(10_000); // base64 模型内嵌
	}, 120_000);

	// Tier1（STEP 输入）下 --preview-html 曾经被静默吞掉（无页面也无警告）——回归守护
	it.skipIf(!hasUv())('STEP(Tier1) convert --preview-html 生成单视窗预览页 + PREVIEW_BEFORE_UNAVAILABLE 披露', () => {
		const dir = freshDir('e2e-step-preview');
		const copy = path.join(dir, 'cube.step');
		fs.copyFileSync(FIX('step/cube.step'), copy);
		const r = cli(['convert', copy, '--to', 'glb', '--preview-html', '--json', '--overwrite']);
		expect(r.code).toBe(0);
		const m = r.manifest!;
		const preview = m.output.files.find((f: any) => f.role === 'preview');
		expect(preview).toBeTruthy();
		expect(fs.statSync(preview.path).size).toBe(preview.bytes);
		const html = fs.readFileSync(preview.path, 'utf8');
		expect(html.match(/__(?:DATA|THREE_VERSION)__/g) ?? []).toEqual([]);
		// STEP 无浏览器渲染形态：before 空 + 单视窗降级样式在页内
		expect(html).toContain('"before":[]');
		expect(html).toContain('#panes.single #pane-before');
		expect(html).toContain('AFTER · output');
		// 披露不缺席
		expect(m.warnings.some((w: any) => w.code === 'PREVIEW_BEFORE_UNAVAILABLE')).toBe(true);
	}, 180_000);

	it.skipIf(!hasUv())('STEP(Tier1) convert --to stl --preview-html：产物非 GLB 整页跳过但仍披露', () => {
		const dir = freshDir('e2e-step-preview-stl');
		const copy = path.join(dir, 'cube.step');
		fs.copyFileSync(FIX('step/cube.step'), copy);
		const r = cli(['convert', copy, '--to', 'stl', '--preview-html', '--json', '--overwrite']);
		expect(r.code).toBe(0);
		const m = r.manifest!;
		expect(m.output.files.some((f: any) => f.role === 'preview')).toBe(false);
		expect(m.warnings.some((w: any) => w.code === 'PREVIEW_BEFORE_UNAVAILABLE')).toBe(true);
	}, 180_000);

	// STEP 是 CAD 惯例 Z-up，glTF 规范 Y-up：产物必须旋转过（assembly 的立柱沿 +Z，
	// 转换后高度应出现在 Y 轴）且 manifest 披露 UP_AXIS_NORMALIZED
	it.skipIf(!hasUv())('STEP(Tier1) 产物为 glTF 规范 Y-up + UP_AXIS_NORMALIZED 披露', () => {
		const dir = freshDir('e2e-step-yup');
		const copy = path.join(dir, 'assembly.step');
		fs.copyFileSync(FIX('step/assembly.step'), copy);
		const r = cli(['convert', copy, '--to', 'glb', '--json', '--overwrite']);
		expect(r.code).toBe(0);
		expect(r.manifest!.warnings.some((w: any) => w.code === 'UP_AXIS_NORMALIZED')).toBe(true);

		const [lo, hi] = glbAccessorBounds(path.join(dir, 'assembly.meshify', 'assembly.converted-glb.glb'));
		// fixture：x[-1.5,1.5] y[-1,1] z[-0.2,2.0]（Z-up）→ Y-up 后 y[-0.2,2.0] z[-1,1]
		expect(lo[0]).toBeCloseTo(-1.5, 3);
		expect(hi[0]).toBeCloseTo(1.5, 3);
		expect(lo[1]).toBeCloseTo(-0.2, 3);
		expect(hi[1]).toBeCloseTo(2.0, 3);
		expect(lo[2]).toBeCloseTo(-1.0, 3);
		expect(hi[2]).toBeCloseTo(1.0, 3);
	}, 180_000);

	// 部件在源文件里躺着建模（朝上轴非 Z）时，--up-axis 显式扶正；
	// 反向值（-x）以 = 传值（commander 会把裸 -x 当 flag 报缺参）
	it.skipIf(!hasUv())('STEP(Tier1) convert --up-axis x / -x：指定朝上轴扶正', () => {
		const dir = freshDir('e2e-step-upaxis');
		const copy = path.join(dir, 'assembly.step');
		fs.copyFileSync(FIX('step/assembly.step'), copy);
		const out = path.join(dir, 'assembly.meshify', 'assembly.converted-glb.glb');

		const rx = cli(['convert', copy, '--to', 'glb', '--up-axis', 'x', '--json', '--overwrite']);
		expect(rx.code).toBe(0);
		expect(rx.manifest!.params.up_axis).toBe('x');
		expect(rx.manifest!.warnings.some((w: any) => w.code === 'UP_AXIS_NORMALIZED')).toBe(true);
		// fixture x[-1.5,1.5] y[-1,1] z[-0.2,2.0]；--up-axis x → (z,x,y)：源 X（150 向）立到 Y
		let [lo, hi] = glbAccessorBounds(out);
		expect(lo[0]).toBeCloseTo(-0.2, 3);
		expect(hi[0]).toBeCloseTo(2.0, 3);
		expect(lo[1]).toBeCloseTo(-1.5, 3);
		expect(hi[1]).toBeCloseTo(1.5, 3);
		expect(lo[2]).toBeCloseTo(-1.0, 3);
		expect(hi[2]).toBeCloseTo(1.0, 3);

		const rn = cli(['convert', copy, '--to', 'glb', '--up-axis=-x', '--json', '--overwrite']);
		expect(rn.code).toBe(0);
		// --up-axis -x → (y,-x,z)：源 Z 立柱回到 Z 轴（旋转反向，非镜像——镜像会让手性反转）
		[lo, hi] = glbAccessorBounds(out);
		expect(lo[0]).toBeCloseTo(-1.0, 3);
		expect(hi[0]).toBeCloseTo(1.0, 3);
		expect(lo[1]).toBeCloseTo(-1.5, 3);
		expect(hi[1]).toBeCloseTo(1.5, 3);
		expect(lo[2]).toBeCloseTo(-0.2, 3);
		expect(hi[2]).toBeCloseTo(2.0, 3);
	}, 300_000);

	// --up-axis auto：带四角孔底板的躺姿部件（fixture 底板 z=0..3、总高 21、四角 r=1.5 通孔）
	// → 高置信判定朝上轴 z + UP_AXIS_AUTO 披露 + 旋转扶正（高度 21 立到 Y）
	it.skipIf(!hasUv())('STEP(Tier1) convert --up-axis auto：高置信自动扶正 + UP_AXIS_AUTO 披露', () => {
		const dir = freshDir('e2e-step-upaxis-auto');
		const copy = path.join(dir, 'holed-base.step');
		fs.copyFileSync(FIX('step/holed-base.step'), copy);
		const out = path.join(dir, 'holed-base.meshify', 'holed-base.converted-glb.glb');

		const r = cli(['convert', copy, '--to', 'glb', '--up-axis', 'auto', '--json', '--overwrite']);
		expect(r.code).toBe(0);
		expect(r.manifest!.params.up_axis).toBe('auto');
		expect(r.manifest!.params.up_axis_resolved).toBe('z');
		const codes = r.manifest!.warnings.map((w: any) => w.code);
		expect(codes).toContain('UP_AXIS_AUTO');
		expect(codes).toContain('UP_AXIS_NORMALIZED');
		// fixture 40(X)×30(Y)×21(Z) 躺姿建模；auto 判 z → (x,z,-y)：总高 21 立到 Y、底面 y=0
		const [lo, hi] = glbAccessorBounds(out);
		expect(lo[0]).toBeCloseTo(-20, 3);
		expect(hi[0]).toBeCloseTo(20, 3);
		expect(lo[1]).toBeCloseTo(0, 3);
		expect(hi[1]).toBeCloseTo(21, 3);
		expect(lo[2]).toBeCloseTo(-15, 3);
		expect(hi[2]).toBeCloseTo(15, 3);
	}, 300_000);

	// --up-axis auto 低置信（对称无孔立方体）必须拒绝并列候选，绝不静默猜一个方向
	it.skipIf(!hasUv())('STEP(Tier1) convert --up-axis auto：无孔对称件 exit 4 拒绝并列候选', () => {
		const dir = freshDir('e2e-step-upaxis-auto-reject');
		const copy = path.join(dir, 'cube.step');
		fs.copyFileSync(FIX('step/cube.step'), copy);
		const r = cli(['convert', copy, '--to', 'glb', '--up-axis', 'auto', '--json', '--overwrite']);
		expect(r.code).toBe(4);
		// Tier1 失败路径：错误详情在 stdout 的 failure manifest（errors[0]），不在 stderr
		const err = (r.manifest!.errors ?? [])[0] ?? '';
		expect(err).toContain('--up-axis auto could not resolve');
		expect(err).toContain('Candidates');
	}, 180_000);

	// --up-axis 对非 STEP 输入必须显式拒绝（exit 4），静默忽略会让用户以为朝向已处理
	it('--up-axis 非 STEP 输入 → exit 4 参数冲突', () => {
		const dir = freshDir('e2e-upaxis-conflict');
		const copy = path.join(dir, 'model.glb');
		fs.copyFileSync(FIX('glb/small.glb'), copy);
		const r = cli(['convert', copy, '--to', 'stl', '--up-axis', 'x', '--json', '--overwrite']);
		expect(r.code).toBe(4);
		expect(r.stderr).toContain('--up-axis only applies to STEP');
	}, 60_000);

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
