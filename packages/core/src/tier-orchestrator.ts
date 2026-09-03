import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EXIT_EXECUTOR_UNAVAILABLE } from './exit-codes.js';
import { warn, type ReportWarning } from './warnings.js';

/**
 * Tier 仲裁（core 中唯一「知道两个内核存在」的模块）。
 *
 * 两条硬规则（plan §Step 1.2）：
 * 1. Tier1 输入含 skin/蒙皮/动画/morph 时自动降回 Tier0，
 *    写 SKIN_ANIMATION_PRESERVED 警告（trimesh 管线加载即丢动画，已证实的路线盲区）。
 * 2. Tier1 需要但未就绪时：给出安装指引；可降级的一律降级执行 Tier0
 *    并必写 TIER_DOWNGRADED 警告，无 TS 回退路径（STEP）则 exit 5 —— 绝不信默降级。
 */

export type Tier = 'ts-wasm' | 'python-uv';
export type TierPreference = 'auto' | 'ts' | 'py';

export interface TierEnv {
	/** uv 可执行文件可用 */
	uv: boolean;
	/** 系统有可用 Python（uv 可自动拉独立解释器，因此 uv=true 即视为 true） */
	python: boolean;
	/** kernel-py 已 uv sync（.venv 就绪） */
	kernelReady: boolean;
	/** kernel-py 仓库目录（null = 未找到） */
	kernelDir: string | null;
	checkedAt: number;
}

export const DEFAULT_TIER_ENV: TierEnv = {
	uv: false,
	python: false,
	kernelReady: false,
	kernelDir: null,
	checkedAt: 0,
};

export const TIER1_INSTALL_GUIDE = [
	'Tier1（Python 增强内核）未就绪。安装步骤：',
	'  1) 安装 uv（单文件安装器，不污染系统）：',
	'     Windows:  powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"',
	'     macOS/Linux:  curl -LsSf https://astral.sh/uv/install.sh | sh',
	'     （或直接运行: meshify doctor --install-uv）',
	'  2) 同步 Python 内核依赖：',
	'     cd packages-py/kernel-py && uv sync',
	'  3) 国内网络建议先配置镜像：',
	'     set UV_DEFAULT_INDEX=https://pypi.tuna.tsinghua.edu.cn/simple',
	'     （或阿里云 https://mirrors.aliyun.com/pypi/simple/）',
].join('\n');

export interface TierDecision {
	tier: Tier;
	warnings: ReportWarning[];
	/** 非 null 时命令应立即失败（exit code 5） */
	error: { code: number; message: string } | null;
	installGuide: string | null;
}

/** 是否为只有 Tier1 能处理的输入（STEP/STP CAD）。 */
export function requiresTier1(format: string): boolean {
	return format === 'step' || format === 'stp';
}

export function decideTier(opts: {
	command: string;
	format: string;
	hasAnimation: boolean;
	pref: TierPreference;
	env: TierEnv;
}): TierDecision {
	const needsPy = requiresTier1(opts.format);
	const hasTsFallback = !needsPy;

	// 显式 --tier ts：STEP 无 TS 路径，直接失败（exit 5）
	if (opts.pref === 'ts') {
		if (needsPy) {
			return {
				tier: 'ts-wasm',
				warnings: [],
				error: {
					code: EXIT_EXECUTOR_UNAVAILABLE,
					message:
						`输入为 ${opts.format.toUpperCase()}（CAD B-rep），只有 Tier1 (Python/gmsh) 能解析，` +
						'--tier ts 无法执行。请改用 --tier auto 或 --tier py（需先安装 Tier1）。',
				},
				installGuide: TIER1_INSTALL_GUIDE,
			};
		}
		return { tier: 'ts-wasm', warnings: [], error: null, installGuide: null };
	}

	// --tier py 或 auto 且命令确需 Tier1
	const wantPy = opts.pref === 'py' || needsPy;
	if (!wantPy) {
		return { tier: 'ts-wasm', warnings: [], error: null, installGuide: null };
	}

	// 硬规则 1：动画/蒙皮输入自动降回 Tier0
	if (opts.hasAnimation) {
		return {
			tier: 'ts-wasm',
			warnings: [
				warn(
					'SKIN_ANIMATION_PRESERVED',
					'输入包含 skin/蒙皮/动画/morph，已自动改用 Tier0 (gltf-transform) 执行：' +
						'Tier1 的 trimesh 管线加载即丢失动画/蒙皮，Tier0 操作 glTF 场景图本身可结构性保留。',
				),
			],
			error: null,
			installGuide: null,
		};
	}

	if (opts.env.kernelReady && opts.env.uv) {
		return { tier: 'python-uv', warnings: [], error: null, installGuide: null };
	}

	// 硬规则 2：Tier1 未就绪
	if (!hasTsFallback) {
		return {
			tier: 'python-uv',
			warnings: [],
			error: {
				code: EXIT_EXECUTOR_UNAVAILABLE,
				message: `Tier1 未就绪（uv=${opts.env.uv}, kernel=${opts.env.kernelReady}），${opts.format.toUpperCase()} 转换无 Tier0 回退路径。`,
			},
			installGuide: TIER1_INSTALL_GUIDE,
		};
	}
	return {
		tier: 'ts-wasm',
		warnings: [
			warn(
				'TIER_DOWNGRADED',
				opts.pref === 'py'
					? '显式要求的 Tier1 (Python) 未就绪，已降级为 Tier0 (TS/WASM) 执行。质量差异见 references/tiering.md。'
					: 'Tier1 未就绪，已用 Tier0 (TS/WASM) 执行。',
			),
		],
		error: null,
		installGuide: TIER1_INSTALL_GUIDE,
	};
}

// ---------------------------------------------------------------------------
// doctor 探测缓存（~/.meshify/doctor.json），tier-orchestrator 复用避免重复探测
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export function tierCacheDir(): string {
	return path.join(os.homedir(), '.meshify');
}

export function tierCachePath(): string {
	return path.join(tierCacheDir(), 'doctor.json');
}

export function readTierEnvCache(maxAgeMs = CACHE_TTL_MS): TierEnv | null {
	try {
		const raw = fs.readFileSync(tierCachePath(), 'utf-8');
		const parsed = JSON.parse(raw) as Partial<TierEnv>;
		if (typeof parsed.checkedAt !== 'number') return null;
		if (Date.now() - parsed.checkedAt > maxAgeMs) return null;
		return { ...DEFAULT_TIER_ENV, ...parsed } as TierEnv;
	} catch {
		return null;
	}
}

export function writeTierEnvCache(env: TierEnv): void {
	try {
		fs.mkdirSync(tierCacheDir(), { recursive: true });
		fs.writeFileSync(tierCachePath(), JSON.stringify(env, null, 2), 'utf-8');
	} catch {
		// 缓存写失败不致命
	}
}
