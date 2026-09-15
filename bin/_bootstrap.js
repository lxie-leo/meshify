#!/usr/bin/env node
// 根启动器引导：检出/插件缓存不含构建产物（dist 被 gitignore），
// 首次运行时自动构建 packages/cli，之后零开销转发到 CLI bin。
// 运行时消息一律英文（仓库约定）；构建失败给修复指引并以 8（内部错误）退出。
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI_BIN = join(ROOT, 'packages', 'cli', 'bin', 'meshify.js');
const CLI_DIST = join(ROOT, 'packages', 'cli', 'dist', 'index.js');

function fail(msg) {
	process.stderr.write(`[meshify] ${msg}\n`);
	process.exit(8);
}

if (!existsSync(CLI_DIST)) {
	process.stderr.write(
		'[meshify] First run: building the CLI (pnpm install + tsc). ' +
			'One-time per install/update; later runs start instantly.\n',
	);
	const step = (cmd) => {
		// shell:true 兼容 Windows（pnpm 实为 pnpm.cmd）；命令固定无用户输入，无注入面
		const r = spawnSync(cmd, { shell: true, cwd: ROOT, stdio: 'inherit' });
		if (r.status !== 0) {
			fail(
				`Build step failed: ${cmd}\n` +
					'[meshify] Fix: install pnpm first (npm i -g pnpm), or run the skill installer: ' +
					'skills/meshify/scripts/install.sh (Windows: install.ps1)',
			);
		}
	};
	if (!existsSync(join(ROOT, 'node_modules'))) step('pnpm install --silent');
	step('pnpm -r run build');
	if (!existsSync(CLI_DIST)) {
		fail('Build reported success but packages/cli/dist/index.js is still missing; please report this bug');
	}
}

const r = spawnSync(process.execPath, [CLI_BIN, ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(r.status ?? 8);
