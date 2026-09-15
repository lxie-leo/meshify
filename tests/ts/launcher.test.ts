/** 根启动器（bin/meshify）契约：插件 PATH 分发断点的回归测试（bin/ 缺失时裸命令解析不到）。 */
import { describe, expect, test } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, FIX, freshDir } from './helpers.js';

const SHIM = path.join(ROOT, 'bin', process.platform === 'win32' ? 'meshify.cmd' : 'meshify');

/** win32 下 .cmd 须经 shell 解析；POSIX 直接执行 shebang 脚本。shimPath 用于隔离副本场景。 */
function launch(args: string[], opts: { shim?: string; cwd?: string } = {}) {
	const shim = opts.shim ?? SHIM;
	const cwd = opts.cwd ?? ROOT;
	return process.platform === 'win32'
		? spawnSync(`"${shim}" ${args.join(' ')}`, { encoding: 'utf8', shell: true, cwd })
		: spawnSync(shim, args, { encoding: 'utf8', cwd });
}

describe('root launcher (bin/meshify)', () => {
	test('fast path: --version forwards to the built CLI', () => {
		const r = launch(['--version']);
		expect(r.status).toBe(0);
		expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
	});

	test('forwards args end-to-end and emits the manifest protocol', () => {
		const dir = freshDir('launcher');
		fs.copyFileSync(FIX('glb/dense.glb'), path.join(dir, 'dense.glb'));
		const r = launch(['inspect', 'dense.glb', '--json'], { cwd: dir });
		expect(r.status).toBe(0);
		const manifest = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
		expect(manifest.command).toBe('inspect');
		expect(manifest.input.faces).toBeGreaterThan(0);
	});

	test('no dist: exits 8, never fake success and never builds the parent workspace', () => {
		const dir = freshDir('launcher-nodist');
		fs.mkdirSync(path.join(dir, 'bin'));
		// 只带启动器不带仓库其余部分 → dist 缺失走构建分支。
		// 隔离桶自带空 workspace，阻止 pnpm 向上解析到真实仓库（防止误构建父级）；
		// pnpm 可达时空构建后仍缺 dist → "still missing" 分支；不可达时直接指引分支——两者均 exit 8
		fs.copyFileSync(path.join(ROOT, 'bin', '_bootstrap.mjs'), path.join(dir, 'bin', '_bootstrap.mjs'));
		fs.copyFileSync(SHIM, path.join(dir, 'bin', path.basename(SHIM)));
		fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'launcher-isolation', private: true }));
		fs.writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), 'packages: []\n');
		const r = launch(['--version'], { shim: path.join(dir, 'bin', path.basename(SHIM)), cwd: dir });
		expect(r.status).toBe(8);
		expect(r.stderr).toContain('[meshify]');
	});
});
