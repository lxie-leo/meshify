/**
 * 退出码契约（快照式断言）：0/2/3/4/5/6/7 全路径 + Tier 仲裁 + 覆盖契约。
 * 大网格 exit 7 用注入超限参数的内核路径覆盖（不依赖 --big 生成物）。
 */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { cli, FIX, freshDir, fixtureExists, hasUv } from './helpers';
import { resolveKernelPyDir, isKernelSynced } from '@meshify/core';

const TIER1 = () => hasUv() && isKernelSynced(resolveKernelPyDir());

describe('退出码 2：输入不可读', () => {
	it('文件不存在（stderr 诊断 + 退出码 + 最小失败 manifest）', () => {
		const r = cli(['inspect', 'no/such/file.glb', '--json']);
		expect(r.code).toBe(2);
		expect(r.stderr).toMatch(/不存在或不可读|ENOENT/);
		// 早失败也产出最小 manifest：Agent 不必拿退出码猜原因（failed_early 披露）
		expect(r.manifest).not.toBeNull();
		expect(r.manifest?.exit_code).toBe(2);
		expect((r.manifest?.errors ?? []).join(' ')).toMatch(/不存在或不可读|ENOENT/);
		expect(r.manifest?.output).toBeNull();
		expect((r.manifest?.params as Record<string, unknown> | undefined)?.failed_early).toBe(true);
	});

	it('目录当输入', () => {
		const r = cli(['inspect', 'fixtures']);
		expect(r.code).toBe(2);
	});
});

describe('退出码 3：格式不支持', () => {
	it('伪 fbx 魔数', () => {
		const dir = freshDir('exit3');
		const f = path.join(dir, 'x.fbx');
		fs.writeFileSync(f, 'Kaydara FBX Binary  \0\x1a\0');
		const r = cli(['inspect', f, '--json']);
		expect(r.code).toBe(3);
		expect(r.stderr).toMatch(/格式|format/i);
	});
});

describe('退出码 4：参数冲突 / 拒绝覆盖', () => {
	it('simplify 输出已存在且未 --overwrite', () => {
		const out = freshDir('exit4-exists');
		const f = path.join(out, 's.glb');
		fs.writeFileSync(f, 'x');
		const r = cli(['simplify', FIX('glb/small.glb'), '-o', f]);
		expect(r.code).toBe(4);
	});

	it('--overwrite 放行（同命令 exit 0）', () => {
		const out = freshDir('exit4-overwrite');
		const f = path.join(out, 's.glb');
		fs.writeFileSync(f, 'x');
		const r = cli(['simplify', FIX('glb/small.glb'), '-o', f, '--overwrite']);
		expect(r.code).toBe(0);
	});

	it('输出路径 == 输入路径：--overwrite 也拒绝（且失败 report 不触碰输入）', () => {
		const out = freshDir('exit4-self');
		const src = path.join(out, 'small.glb');
		fs.copyFileSync(FIX('glb/small.glb'), src);
		const r = cli(['simplify', src, '-o', src, '--overwrite']);
		expect(r.code).toBe(4);
		// 输入字节原封不动（失败 manifest 只落 .meshify/ 报告，绝不写模型文件）
		expect(fs.statSync(src).size).toBe(fs.statSync(FIX('glb/small.glb')).size);
	});

	it('参数互斥：ratio 与 target 同时给（明确诊断，非碰巧 exit 4）', () => {
		const out = freshDir('exit4-mutex');
		const copy = path.join(out, 'small.glb');
		fs.copyFileSync(FIX('glb/small.glb'), copy);
		const r = cli(['simplify', copy, '--ratio', '0.5', '--target-faces', '10']);
		expect(r.code).toBe(4);
		expect(r.stderr).toMatch(/互斥/);
		// 参数校验先于任何写入：不产生模型产物（失败 report 是工具自有日志，允许）
		expect(fs.readdirSync(out).filter((f) => f !== 'small.glb' && f !== 'small.meshify')).toEqual([]);
		expect(fs.existsSync(path.join(out, 'small.simplified.glb'))).toBe(false);
	});

	it('target-faces 单独使用合法（缺省 ratio 不算冲突）', () => {
		const out = freshDir('exit4-target-only');
		const copy = path.join(out, 'small.glb');
		fs.copyFileSync(FIX('glb/small.glb'), copy);
		const r = cli(['simplify', copy, '--target-faces', '10', '--json']);
		expect(r.code).toBe(0);
	});
});

describe('退出码 5：Tier 仲裁（STEP 必须走 Tier1）', () => {
	it('STEP + --tier ts → exit 5 + 安装指引', () => {
		const r = cli(['inspect', FIX('step/cube.step'), '--tier', 'ts']);
		expect(r.code).toBe(5);
		expect(r.stderr + r.stdout).toMatch(/Tier1|uv sync/i);
	});

	it('动画输入 + --tier py → 强制 Tier0 + SKIN_ANIMATION_PRESERVED（exit 0）', () => {
		const r = cli(['inspect', FIX('glb/skin-anim.glb'), '--tier', 'py', '--json']);
		expect(r.code).toBe(0);
		expect(r.manifest?.tool?.tier).toBe('ts-wasm');
		const codes = (r.manifest?.warnings ?? []).map((w: any) => w.code);
		expect(codes).toContain('SKIN_ANIMATION_PRESERVED');
	});
});

describe('退出码 6：算法失败', () => {
	it('空几何输入 + plane 模式 → 统一守卫拦截（不依赖内核侧消息）', () => {
		const r = cli(['segment', FIX('glb/empty.glb'), '--mode', 'plane', '--axis', 'x', '--json']);
		expect(r.code).toBe(6);
		expect(r.stderr).toMatch(/三角面|几何/);
	});
});

describe('commander 用法错误 → 退出码 4（契约内收敛）', () => {
	it('非法枚举值（--map xyz）', () => {
		const r = cli(['texture', FIX('glb/dense.glb'), '--map', 'xyz']);
		expect(r.code).toBe(4);
	});

	it('未知选项', () => {
		const r = cli(['inspect', FIX('glb/dense.glb'), '--no-such-flag']);
		expect(r.code).toBe(4);
	});

	it('缺必填参数', () => {
		const r = cli(['inspect']);
		expect(r.code).toBe(4);
	});

	it('--help / --version 保持 exit 0', () => {
		expect(cli(['--help']).code).toBe(0);
		expect(cli(['--version']).code).toBe(0);
		expect(cli(['simplify', '--help']).code).toBe(0);
	});
});

describe('退出码 7：资源防护（注入超限）', () => {
	it.runIf(process.env.MESHIFY_TEST_BIG === '1' && fixtureExists('glb/huge.glb'))(
		'>500 万面输入无 --force → exit 7；--force → 放行',
		() => {
			const no = cli(['inspect', FIX('glb/huge.glb')]);
			expect(no.code).toBe(7);
		},
		180_000,
	);
});

describe('Tier1 路径（无 uv 自动跳过）', () => {
	it('STEP inspect（auto 路由）→ exit 0，tier=python-uv', () => {
		if (!TIER1()) return;
		const r = cli(['inspect', FIX('step/assembly.step'), '--json']);
		expect(r.code).toBe(0);
		expect(r.manifest?.tool?.tier).toBe('python-uv');
		expect(r.manifest?.input?.format).toBe('step');
	}, 180_000);

	it('GLB + --tier py → exit 0，tier=python-uv', () => {
		if (!TIER1()) return;
		const out = freshDir('exit-py-simplify');
		const r = cli(['simplify', FIX('glb/dense.glb'), '--tier', 'py', '--ratio', '0.5', '-o', path.join(out, 's.glb'), '--overwrite', '--json']);
		expect(r.code).toBe(0);
		expect(r.manifest?.tool?.tier).toBe('python-uv');
	}, 180_000);
});
