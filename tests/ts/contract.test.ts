/** 契约测试：manifest 双向校验（zod × ajv × 真实产物 × Python 侧样本）。 */

import { describe, it, expect } from 'vitest';
import Ajv from 'ajv';
import {
	MESHIFY_REPORT_JSON_SCHEMA,
	meshifyReportZ,
	WARNING_CODES,
} from '@meshify/core';
import { cli, FIX, fixtureExists, hasUv, freshDir } from './helpers';
import { resolveKernelPyDir, runPythonKernel, isKernelSynced } from '@meshify/core';
import fs from 'node:fs';
import path from 'node:path';

const ajv = new Ajv({ allErrors: true, strict: false });
const validate = ajv.compile(MESHIFY_REPORT_JSON_SCHEMA as any);

/** 双实现一致断言：zod 与 ajv 对同一样本的判定必须相同。 */
function expectAgreement(sample: unknown, shouldPass: boolean, label: string) {
	const zodOk = meshifyReportZ.safeParse(sample).success;
	const ajvOk = validate(sample) as boolean;
	expect({ zodOk, ajvOk, label }, label).toEqual({ zodOk: shouldPass, ajvOk: shouldPass, label });
}

/** 最小合法 manifest（字段齐全、类型正确）。 */
function minimalManifest() {
	return {
		schema: 'meshify.report/v1',
		tool: { name: 'meshify', version: '0.1.0', tier: 'ts-wasm' },
		command: 'inspect',
		input: {
			path: 'a.glb', format: 'glb', bytes: 10, vertices: 3, faces: 1,
			meshes: [{ name: 'm', vertices: 3, faces: 1, material: null, has_uv: false, has_normals: true }],
			materials: 0, textures: [], bbox: [[0, 0, 0], [1, 1, 1]], has_animation: false,
		},
		output: null,
		params: {},
		metrics: { duration_ms: 1.5 },
		warnings: [],
		errors: [],
		exit_code: 0,
	};
}

describe('manifest 契约：合成样本双向校验', () => {
	it('最小合法 manifest 双实现均通过', () => {
		expectAgreement(minimalManifest(), true, 'minimal');
	});

	it('bbox null / output null / 空 params 等边界形态合法', () => {
		const m: any = minimalManifest();
		m.input.bbox = null;
		m.metrics = { duration_ms: 0, tier_note: 'x' };
		m.warnings = [{ code: WARNING_CODES[0], message: 'msg', mesh: 'm' }];
		expectAgreement(m, true, 'boundary shapes');
	});

	const mutations: [string, (m: any) => void][] = [
		['顶层未知字段', (m) => { m.extra = 1; }],
		['metrics 未知字段（additionalProperties:false）', (m) => { m.metrics.stray = 1; }],
		['tool.tier 非法枚举', (m) => { m.tool.tier = 'rust'; }],
		['warning.code 未注册码', (m) => { m.warnings = [{ code: 'NOT_A_CODE', message: 'x' }]; }],
		['duration_ms 负数', (m) => { m.metrics.duration_ms = -1; }],
		['face_reduction 非数字', (m) => { m.metrics.face_reduction = '30%'; }],
		['schema 字面量错误', (m) => { m.schema = 'meshify.report/v2'; }],
		['input.meshes 顶点数负数', (m) => { m.input.meshes[0].vertices = -3; }],
		['fileInfo.role 非法', (m) => {
			m.output = { path: 'o.glb', format: 'glb', bytes: 1, vertices: 1, faces: 1, files: [{ path: 'o.glb', bytes: 1, role: 'unknown' }] };
		}],
		['errors 非字符串元素', (m) => { m.errors = [42]; }],
		['exit_code 非整数', (m) => { m.exit_code = 0.5; }],
		['input 缺 has_animation', (m) => { delete m.input.has_animation; }],
	];
	for (const [label, mutate] of mutations) {
		it(`拒绝：${label}`, () => {
			const m = minimalManifest();
			mutate(m);
			expectAgreement(m, false, label);
		});
	}
});

describe('manifest 契约：真实 CLI 产物', () => {
	it('inspect --json 产物 zod + ajv 双通过（Tier0）', () => {
		const r = cli(['inspect', FIX('glb/multimat.glb'), '--json']);
		expect(r.code).toBe(0);
		expect(r.manifest).toBeTruthy();
		expectAgreement(r.manifest, true, 'cli inspect');
	});

	it('simplify --json 产物双通过（含 metrics/warnings 形态）', () => {
		const out = freshDir('contract-simplify');
		const r = cli(['simplify', FIX('glb/dense.glb'), '--ratio', '0.5', '--json', '-o', path.join(out, 's.glb')]);
		expect(r.code).toBe(0);
		expectAgreement(r.manifest, true, 'cli simplify');
		expect((r.manifest as any).metrics.face_reduction).toBeGreaterThan(0.4);
	});

	it('segment --json 多部件产物双通过（parts/files 形态）', () => {
		const out = freshDir('contract-segment');
		const copy = path.join(out, 'multimat.glb');
		fs.copyFileSync(FIX('glb/multimat.glb'), copy);
		const r = cli(['segment', copy, '--mode', 'connected', '--json']);
		expect(r.code).toBe(0);
		expectAgreement(r.manifest, true, 'cli segment');
		// Tier0：单 GLB 多节点（部件在 metrics.parts 披露）
		expect((r.manifest as any).metrics.parts.length).toBeGreaterThan(1);
		expect((r.manifest as any).output.files.some((f: any) => f.role === 'asset')).toBe(true);
	});
});

describe('manifest 契约：Python 侧产物（无 uv 自动跳过）', () => {
	it('kernel-py inspect manifest 双通过（跨语言契约）', async () => {
		if (!hasUv() || !isKernelSynced(resolveKernelPyDir())) return;
		const result = await runPythonKernel({
			command: 'inspect', params: {}, input: FIX('step/cube.step'),
		});
		expect(result.report.exit_code, `kernel-py errors: ${JSON.stringify(result.report.errors)}`).toBe(0);
		// 双实现对 Python 产物的判定一致且通过
		expectAgreement(result.report, true, 'python inspect step');
	}, 120_000);

	it('kernel-py simplify manifest 双通过（GLB 输入）', async () => {
		if (!hasUv() || !isKernelSynced(resolveKernelPyDir())) return;
		const out = freshDir('contract-py-simplify');
		const output = path.join(out, 's.glb');
		const result = await runPythonKernel({
			command: 'simplify', params: { ratio: 0.5 }, input: FIX('glb/dense.glb'), output, overwrite: true,
		});
		expect(result.report.exit_code).toBe(0);
		expectAgreement(result.report, true, 'python simplify');
		expect(fs.existsSync(output)).toBe(true);
	}, 120_000);
});
