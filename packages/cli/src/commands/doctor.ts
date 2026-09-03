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
		.description('环境自检：Node / Tier0 (WASM) / Tier1 (uv + kernel-py) / 磁盘；结果缓存 24h 供 tier 仲裁复用')
		.option('--json', 'stdout 输出 JSON')
		.option('--install-uv', '引导安装 uv（单文件安装器；Windows 用 PowerShell 脚本，其余 curl|sh）')
		.option('--refresh', '忽略缓存强制重新探测')
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
	const nodeOk = /^v(1[89]|2[0-9])\./.test(nodeVersion) && satisfiesMin(nodeVersion, 18, 17);

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
	process.stdout.write(`安装 uv（${cmd[0]} …）：\n`);
	const r = spawnSync(cmd[0], cmd[1], { stdio: 'inherit', windowsHide: false });
	if (r.status !== 0) {
		process.stderr.write(
			'uv 安装失败。手动安装：\n  Windows:  powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"\n' +
				'  macOS/Linux:  curl -LsSf https://astral.sh/uv/install.sh | sh\n' +
				'国内网络建议先设置镜像: UV_DEFAULT_INDEX=https://pypi.tuna.tsinghua.edu.cn/simple\n',
		);
		return false;
	}
	process.stdout.write('uv 安装完成。重开终端（刷新 PATH）后再运行 meshify doctor 验证。\n');
	return true;
}

function printDoctor(result: Awaited<ReturnType<typeof runDoctor>>): void {
	const mark = (ok: boolean) => (ok ? '[ok]' : '[FAIL]');
	const lines: string[] = [];
	lines.push(`meshify doctor（${result.tool.version}）`);
	lines.push(`${mark(result.node.ok)} Node ${result.node.version}（要求 ${result.node.required}）`);
	lines.push(`${mark(result.tier0.meshoptWasm)} Tier0 meshoptimizer WASM（QEM 简化/压缩）`);
	lines.push(`${mark(result.tier0.sharp)} Tier0 sharp（贴图压缩/降采样）`);
	lines.push(`${mark(result.tier0.earcut)} Tier0 earcut（截面封口三角化）`);
	lines.push(`${result.tier0.draco ? '[ok]' : '[--]'} Tier0 draco3dgltf（可选：draco 压缩；未装则 optimize --compression draco 自动跳过）`);
	lines.push(`${result.tier1.uv ? '[ok]' : '[--]'} Tier1 uv ${result.tier1.uvVersion ?? ''}`.trimEnd());
	lines.push(`${result.tier1.python ? '[ok]' : '[--]'} Tier1 Python 可用性`);
	lines.push(
		`${result.tier1.kernelDir ? '[ok]' : '[--]'} Tier1 kernel-py 目录 ${result.tier1.kernelDir ?? '（未找到 packages-py/kernel-py）'}`,
	);
	if (result.tier1.kernelDir) {
		lines.push(
			`${result.tier1.kernelReady ? '[ok]' : '[--]'} Tier1 依赖同步（.venv）${
				result.tier1.kernelReady ? '' : '—— cd packages-py/kernel-py && uv sync'
			}`,
		);
		if (result.tier1.importCheck) {
			lines.push(
				`${result.tier1.importCheck === 'ok' ? '[ok]' : '[FAIL]'} Tier1 import 深检 ${result.tier1.importCheck === 'ok' ? '' : result.tier1.importCheck}`,
			);
		}
	}
	lines.push(
		`${result.disk.freeGB === null ? '[--]' : result.disk.freeGB > 2 ? '[ok]' : '[FAIL]'} 磁盘剩余 ${result.disk.freeGB ?? '?'} GB（${result.disk.path}）`,
	);
	for (const f of result.tier0.failures) lines.push(`  详情: ${f}`);
	lines.push(result.tier0Ok ? '结论: Tier0 基线可用；Tier1 ' + (result.tier1.kernelReady && result.tier1.importCheck === 'ok' ? '就绪' : '未就绪（可选）') : '结论: Tier0 基线异常，工具不可用 —— 重新安装 meshify 或检查 Node 版本');
	process.stdout.write(lines.join('\n') + '\n');
	if (!result.tier1.uv) {
		process.stdout.write(
			'Tier1 安装指引：\n  meshify doctor --install-uv\n  cd ' +
				path.join('packages-py', 'kernel-py') +
				' && uv sync\n  国内镜像: set UV_DEFAULT_INDEX=https://pypi.tuna.tsinghua.edu.cn/simple\n',
		);
	}
}
