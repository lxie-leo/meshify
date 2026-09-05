import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Command } from 'commander';
import { TOOL_VERSION, hasUv, isKernelSynced, resolveKernelPyDir, verifyKernelImport, writeTierEnvCache } from '@meshify/core';
import { tier0SelfCheck } from '@meshify/kernel-ts';

/**
 * meshify doctor —— 环境自检（plan §Step 1.4）。
 * Node 版本 / Tier0 WASM+sharp+earcut+draco / uv+python / kernel-py 就绪与导入深检 /
 * 磁盘空间；探测结果写 ~/.meshify/doctor.json 缓存供 tier-orchestrator 复用。
 * --install-uv：单文件安装器引导（uv 是 Tier1 唯一安装通道，不污染系统）。
 */
export function registerDoctor(program: Command): void {
	program
		.command('doctor')
		.description('Environment check: Node / Tier0 (WASM) / Tier1 (uv + kernel-py) / disk; results cached 24h for tier routing')
		.option('--json', 'write JSON to stdout')
		.option('--install-uv', 'install uv (single-file installer; PowerShell script on Windows, curl|sh elsewhere)')
		.action(async (cmdOpts: Record<string, unknown>) => {
			const json = !!cmdOpts.json;

			if (cmdOpts.installUv) {
				const ok = installUv();
				if (!ok) {
					process.exitCode = 5;
					return;
				}
			}

			const result = await runDoctor();
			writeTierEnvCache({
				uv: result.tier1.uv,
				python: result.tier1.python,
				kernelReady: result.tier1.kernelReady,
				kernelDir: result.tier1.kernelDir,
				checkedAt: Date.now(),
			});

			if (json) {
				process.stdout.write(JSON.stringify(result, null, 2) + '\n');
			} else {
				printDoctor(result);
			}
			// Tier0 是基线能力：损坏即本工具不可用
			if (!result.tier0Ok) process.exitCode = 5;
		});
}

async function runDoctor() {
	const nodeVersion = process.version;
	// 版本判定交给数值比较（satisfiesMin 已覆盖 30+ 等未来主版本），不再用枚举式正则
	const nodeOk = satisfiesMin(nodeVersion, 18, 17);

	const t0 = await tier0SelfCheck();
	const tier0Ok = nodeOk && t0.meshoptWasm && t0.sharp && t0.earcut;

	const uvVersion = hasUv() ? (spawnSync('uv', ['--version'], { windowsHide: true, encoding: 'utf-8' }).stdout || '').trim() : null;
	const python = uvVersion ? true : spawnSync('python', ['--version'], { windowsHide: true, encoding: 'utf-8' }).status === 0;
	const kernelDir = resolveKernelPyDir();
	const kernelReady = isKernelSynced(kernelDir);
	let importCheck: string | null = null;
	if (kernelReady && uvVersion) {
		const v = verifyKernelImport(kernelDir!);
		importCheck = v.ok ? 'ok' : v.detail;
	}

	const disk = diskSpace(process.cwd());

	return {
		time: new Date().toISOString(),
		tool: { name: 'meshify', version: TOOL_VERSION },
		node: { version: nodeVersion, ok: nodeOk, required: '>=18.17' },
		platform: `${os.platform()} ${os.arch()}`,
		cwd: process.cwd(),
		tier0: { ...t0, ok: tier0Ok },
		tier0Ok,
		tier1: {
			uv: !!uvVersion,
			uvVersion,
			python,
			kernelDir,
			kernelReady,
			importCheck,
		},
		disk,
	};
}

function satisfiesMin(version: string, major: number, minor: number): boolean {
	const m = /^v(\d+)\.(\d+)\./.exec(version);
	if (!m) return false;
	const maj = Number(m[1]);
	const min = Number(m[2]);
	return maj > major || (maj === major && min >= minor);
}

function diskSpace(dir: string): { path: string; freeGB: number | null } {
	try {
		const st = fs.statfsSync(dir);
		return { path: dir, freeGB: Math.round(((st.bavail * st.bsize) / 1024 ** 3) * 10) / 10 };
	} catch {
		return { path: dir, freeGB: null };
	}
}

function installUv(): boolean {
	const win = process.platform === 'win32';
	const cmd: [string, string[]] = win
		? ['powershell', ['-ExecutionPolicy', 'ByPass', '-c', 'irm https://astral.sh/uv/install.ps1 | iex']]
		: ['sh', ['-c', 'curl -LsSf https://astral.sh/uv/install.sh | sh']];
	process.stdout.write(`Installing uv (${cmd[0]} …):\n`);
	const r = spawnSync(cmd[0], cmd[1], { stdio: 'inherit', windowsHide: false });
	if (r.status !== 0) {
		process.stderr.write(
			'uv installation failed. Manual install:\n  Windows:  powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"\n' +
				'  macOS/Linux:  curl -LsSf https://astral.sh/uv/install.sh | sh\n' +
				'On slow links (mainland China), set a mirror first: UV_DEFAULT_INDEX=https://pypi.tuna.tsinghua.edu.cn/simple\n',
		);
		return false;
	}
	process.stdout.write('uv installed. Reopen the terminal (to refresh PATH), then run meshify doctor to verify.\n');
	return true;
}

function printDoctor(result: Awaited<ReturnType<typeof runDoctor>>): void {
	const mark = (ok: boolean) => (ok ? '[ok]' : '[FAIL]');
	const lines: string[] = [];
	lines.push(`meshify doctor (${result.tool.version})`);
	lines.push(`${mark(result.node.ok)} Node ${result.node.version} (requires ${result.node.required})`);
	lines.push(`${mark(result.tier0.meshoptWasm)} Tier0 meshoptimizer WASM (QEM simplify/compress)`);
	lines.push(`${mark(result.tier0.sharp)} Tier0 sharp (texture compression/downscaling)`);
	lines.push(`${mark(result.tier0.earcut)} Tier0 earcut (cross-section cap triangulation)`);
	lines.push(`${result.tier0.draco ? '[ok]' : '[--]'} Tier0 draco3dgltf (optional: draco compression; when absent, optimize --compression draco skips it)`);
	lines.push(`${result.tier1.uv ? '[ok]' : '[--]'} Tier1 uv ${result.tier1.uvVersion ?? ''}`.trimEnd());
	lines.push(`${result.tier1.python ? '[ok]' : '[--]'} Tier1 Python availability`);
	lines.push(
		`${result.tier1.kernelDir ? '[ok]' : '[--]'} Tier1 kernel-py dir ${result.tier1.kernelDir ?? '(packages-py/kernel-py not found)'}`,
	);
	if (result.tier1.kernelDir) {
		lines.push(
			`${result.tier1.kernelReady ? '[ok]' : '[--]'} Tier1 dependencies synced (.venv)${
				result.tier1.kernelReady ? '' : ' — cd packages-py/kernel-py && uv sync'
			}`,
		);
		if (result.tier1.importCheck) {
			lines.push(
				`${result.tier1.importCheck === 'ok' ? '[ok]' : '[FAIL]'} Tier1 deep import check: ${result.tier1.importCheck === 'ok' ? '' : result.tier1.importCheck}`,
			);
		}
	}
	lines.push(
		`${result.disk.freeGB === null ? '[--]' : result.disk.freeGB > 2 ? '[ok]' : '[FAIL]'} disk free ${result.disk.freeGB ?? '?'} GB (${result.disk.path})`,
	);
	for (const f of result.tier0.failures) lines.push(`  detail: ${f}`);
	lines.push(result.tier0Ok ? 'Summary: Tier0 baseline usable; Tier1 ' + (result.tier1.kernelReady && result.tier1.importCheck === 'ok' ? 'ready' : 'not ready (optional)') : 'Summary: Tier0 baseline broken, the tool is unusable — reinstall meshify or check the Node version');
	process.stdout.write(lines.join('\n') + '\n');
	if (!result.tier1.uv) {
		process.stdout.write(
			'Tier1 install guide:\n  meshify doctor --install-uv\n  cd ' +
				path.join('packages-py', 'kernel-py') +
				' && uv sync\n  PyPI mirror (mainland China): set UV_DEFAULT_INDEX=https://pypi.tuna.tsinghua.edu.cn/simple\n',
		);
	}
}
