import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MeshifyError, EXIT_INTERNAL, EXIT_EXECUTOR_UNAVAILABLE } from './exit-codes.js';
import { validateReport } from './schema.js';
import type { MeshifyReport } from './types.js';
import type { TierEnv } from './tier-orchestrator.js';

/**
 * Tier1 桥：一次性子进程调用 `uv run python -m meshify_kernel <payload.json>`。
 * 文件一律传路径、参数走 JSON（无常驻 daemon，无端口/生命周期问题）。
 * kernel-py 在 stdout 输出完整 manifest JSON（pydantic 校验过的 meshify.report/v1）。
 */

export interface PyPayload {
	command: string;
	params: Record<string, unknown>;
	/** 输入文件绝对路径 */
	input: string;
	/** 单文件输出绝对路径（convert 等） */
	output?: string;
	/** 多部件输出目录绝对路径（segment 等） */
	output_dir?: string;
	force?: boolean;
	/** 显式允许覆盖既有输出（Python 侧对未预声明的部件文件同样强制） */
	overwrite?: boolean;
}

export interface PyRunResult {
	report: MeshifyReport;
	stderr: string;
}

/** 从 core 包位置向上探测 kernel-py 仓库目录。 */
export function resolveKernelPyDir(): string | null {
	const candidates: string[] = [];
	const fromEnv = process.env.MESHIFY_PY_KERNEL_DIR;
	if (fromEnv) candidates.push(fromEnv);

	// <repo>/packages/core/dist/... → <repo>/packages-py/kernel-py
	const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
	let dir = here;
	for (let i = 0; i < 6; i++) {
		dir = path.dirname(dir);
		const candidate = path.join(dir, 'packages-py', 'kernel-py');
		if (fs.existsSync(path.join(candidate, 'pyproject.toml'))) {
			candidates.push(candidate);
			break;
		}
	}
	// 相对 CWD（Agent 常在仓库内运行）
	candidates.push(path.resolve(process.cwd(), 'packages-py', 'kernel-py'));
	candidates.push(path.resolve(process.cwd(), '..', 'packages-py', 'kernel-py'));

	for (const c of candidates) {
		if (fs.existsSync(path.join(c, 'pyproject.toml')) && fs.existsSync(path.join(c, 'src', 'meshify_kernel'))) {
			return path.resolve(c);
		}
	}
	return null;
}

export function isKernelSynced(kernelDir: string | null): boolean {
	if (!kernelDir) return false;
	return fs.existsSync(path.join(kernelDir, '.venv'));
}

export function hasUv(): boolean {
	const r = spawnSync('uv', ['--version'], { windowsHide: true, timeout: 15_000, encoding: 'utf-8' });
	return r.status === 0;
}

/** 深度校验：uv run python -c "import meshify_kernel"（doctor 命令用）。 */
export function verifyKernelImport(kernelDir: string, timeoutMs = 120_000): { ok: boolean; detail: string } {
	const r = spawnSync(
		'uv',
		['run', '--quiet', 'python', '-c', 'import meshify_kernel; print("ok")'],
		{ cwd: kernelDir, windowsHide: true, timeout: timeoutMs, encoding: 'utf-8' },
	);
	if (r.status === 0) return { ok: true, detail: 'import ok' };
	return {
		ok: false,
		detail: (r.stderr || r.stdout || `exit ${r.status}`).toString().slice(0, 500),
	};
}

/** 组装 TierEnv（快速探测：uv PATH 检查 + .venv 存在性检查，不触发真正的 venv 激活）。 */
export function probeTierEnv(): TierEnv {
	const kernelDir = resolveKernelPyDir();
	const uv = hasUv();
	return {
		uv,
		python: uv || spawnSync('python', ['--version'], { windowsHide: true, timeout: 10_000 }).status === 0,
		kernelReady: isKernelSynced(kernelDir),
		kernelDir,
		checkedAt: Date.now(),
	};
}

export async function runPythonKernel(payload: PyPayload, opts: { timeoutMs?: number } = {}): Promise<PyRunResult> {
	const kernelDir = resolveKernelPyDir();
	if (!kernelDir) {
		throw new MeshifyError(
			EXIT_EXECUTOR_UNAVAILABLE,
			'kernel-py directory not found (packages-py/kernel-py). Tier1 requires the in-repo Python kernel; point MESHIFY_PY_KERNEL_DIR at it.',
		);
	}
	if (!hasUv()) {
		throw new MeshifyError(EXIT_EXECUTOR_UNAVAILABLE, 'uv unavailable; cannot start Tier1. Install uv first (meshify doctor --install-uv).');
	}

	const tmp = path.join(os.tmpdir(), `meshify-payload-${process.pid}-${Date.now()}.json`);
	fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf-8');
	let stdout = '';
	let stderr = '';
	try {
		await new Promise<void>((resolve, reject) => {
			const child = spawn('uv', ['run', '--quiet', 'python', '-X', 'utf8', '-m', 'meshify_kernel', tmp], {
				cwd: kernelDir,
				windowsHide: true,
				stdio: ['ignore', 'pipe', 'pipe'],
				// Windows 下 Python stdout 默认 GBK：强制 UTF-8，manifest 中文不乱码
				env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
			});
			const timer = setTimeout(() => {
				child.kill();
				reject(new MeshifyError(7, `Tier1 timed out (>${Math.round((opts.timeoutMs ?? 600_000) / 1000)}s)`));
			}, opts.timeoutMs ?? 600_000);
			child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
			child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
			child.on('error', (err) => {
				clearTimeout(timer);
				reject(new MeshifyError(EXIT_EXECUTOR_UNAVAILABLE, `Failed to spawn uv: ${err.message}`));
			});
			child.on('close', (code) => {
				clearTimeout(timer);
				resolve();
			});
		});
	} finally {
		try {
			fs.unlinkSync(tmp);
		} catch {
			/* ignore */
		}
	}

	const parsed = parseStdoutJson(stdout);
	if (!parsed) {
		throw new MeshifyError(
			EXIT_INTERNAL,
			`Tier1 stdout could not be parsed as manifest JSON. First 500 chars of stdout: ${stdout.slice(0, 500)}\nFirst 500 chars of stderr: ${stderr.slice(0, 500)}`,
		);
	}
	const validated = validateReport(parsed);
	if (!validated.ok) {
		throw new MeshifyError(
			EXIT_INTERNAL,
			`Tier1 manifest failed schema validation: ${validated.errors.issues.map((i) => i.path.join('.')).join(', ')}`,
		);
	}
	return { report: validated.report as MeshifyReport, stderr };
}

function parseStdoutJson(stdout: string): unknown | null {
	const text = stdout.trim();
	if (!text) return null;
	const first = text.indexOf('{');
	const last = text.lastIndexOf('}');
	if (first === -1 || last <= first) return null;
	try {
		return JSON.parse(text.slice(first, last + 1));
	} catch {
		return null;
	}
}
