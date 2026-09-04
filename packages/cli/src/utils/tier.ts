import * as path from 'node:path';
import {
	MeshifyError,
	probeTierEnv,
	readTierEnvCache,
	runPythonKernel,
	decideTier,
	writeTierEnvCache,
	type ReportWarning,
	type Tier,
	type TierDecision,
} from '@meshify/core';
import { readDocument } from '@meshify/kernel-ts';
import { attachTier1Preview } from '../preview/tier1-preview.js';
import { parseTierPref, type GlobalOptions } from './common.js';
import { OutputManager } from './output.js';
import { progress } from './spinner.js';
import { emitExistingReport } from './report-out.js';
import type { InputFormat } from './format-detect.js';

export interface TierRouteOptions {
	/** 命令参数（原样进 payload → manifest.params 回显） */
	params: Record<string, unknown>;
	/** 输出命名段（'simplified' / 'segment-plane' / …） */
	op: string;
	/** 已知输入动画状态；glb/gltf 走 py 时自动探测（trimesh 路线丢动画，硬规则 1） */
	hasAnimation?: boolean;
	/** 多部件输出（segment）→ payload.output_dir */
	multi?: boolean;
	/** 输出扩展名（convert 按目标格式；默认 glb） */
	ext?: string;
}

export interface TierRoute {
	/** true = Tier1 已执行并完成输出（命令应直接返回） */
	handled: boolean;
	/** 实际执行 Tier（handled=false 时恒为 'ts-wasm'） */
	tier: Tier;
	/** 降级/保留动画等仲裁告警（并入 manifest） */
	warnings: ReportWarning[];
}

/**
 * Tier 仲裁统一入口（plan §Step 1.2 两条硬规则在此落地）：
 * 1. 输入含 skin/蒙皮/动画/morph → 自动降回 Tier0 + SKIN_ANIMATION_PRESERVED
 * 2. Tier1 需要但未就绪：无 TS 回退（STEP）→ exit 5 + 安装指引；
 *    有回退 → 降级 Tier0 + TIER_DOWNGRADED（绝不信默降级）
 *
 * doctor 探测缓存（24h）复用；未命中才现场探测。
 */
export async function routeTier(
	command: string,
	input: string,
	format: InputFormat,
	opts: GlobalOptions,
	routeOpts: TierRouteOptions,
): Promise<TierRoute> {
	const pref = parseTierPref(opts.tier);
	const needsPy = format === 'step';
	const wantPy = pref === 'py' || needsPy;
	if (pref === 'ts' || !wantPy) {
		// --tier ts + STEP：无 TS 路径，走 decideTier 拿规范错误（exit 5）
		const decision = await decideWithCache({ command, format, hasAnimation: false, pref });
		if (decision.error) throwDecisionError(decision);
		return { handled: false, tier: 'ts-wasm', warnings: decision.warnings };
	}

	// 硬规则 1 的动画探测（仅 glb/gltf 可能有；STEP/OBJ/STL/PLY 恒 false）
	let hasAnimation = routeOpts.hasAnimation ?? false;
	if (hasAnimation === false && (format === 'glb' || format === 'gltf')) {
		try {
			const doc = await readDocument(input);
			hasAnimation = doc.getRoot().listAnimations().length > 0 || doc.getRoot().listSkins().length > 0;
		} catch {
			hasAnimation = false; // 读取失败留给后续正式加载报错
		}
	}

	const decision = await decideWithCache({ command, format, hasAnimation, pref });
	if (decision.error) throwDecisionError(decision);

	if (decision.tier === 'python-uv') {
		const om = new OutputManager(input, { overwrite: !!opts.overwrite, explicit: opts.output });
		const payload: Parameters<typeof runPythonKernel>[0] = {
			command,
			params: routeOpts.params,
			// 子进程 cwd 是 kernel-py 目录：必须传绝对路径
			input: path.resolve(input),
			force: !!opts.force,
			overwrite: !!opts.overwrite,
		};
		if (routeOpts.multi) {
			const dir = om.partDir(routeOpts.op);
			om.claim(path.join(dir, 'part_000.glb'));
			om.ensureDir(dir);
			payload.output_dir = dir;
		} else {
			const outPath = om.claim(om.file(routeOpts.op, routeOpts.ext ?? 'glb'));
			om.ensureDirFor(outPath);
			payload.output = outPath;
		}
		progress('Tier1 (Python/uv) 执行中…');
		const result = await runPythonKernel(payload);
		// --preview-html 在 Tier1 路径同样生效（成功产物上生成对比页；失败时不伪造）
		if (opts.previewHtml && result.report.exit_code === 0) {
			progress('生成预览页…');
			await attachTier1Preview(result.report, {
				input: path.resolve(input),
				format,
				om,
				mainOutput: payload.output,
			});
		}
		emitExistingReport(result.report, {
			reportPath: opts.report ?? om.reportPath(routeOpts.op),
			json: !!opts.json,
		});
		// Tier1 manifest 自带语义退出码（0/4/6/7…）：如实向调用方传播，绝不出假 0
		if (result.report.exit_code !== 0) process.exitCode = result.report.exit_code;
		return { handled: true, tier: 'python-uv', warnings: [] };
	}

	return { handled: false, tier: decision.tier, warnings: decision.warnings };
}

async function decideWithCache(args: Omit<Parameters<typeof decideTier>[0], 'env'>): Promise<TierDecision> {
	let env = readTierEnvCache();
	if (!env) {
		progress('探测 Tier1 环境（uv / kernel-py）…');
		env = probeTierEnv();
		writeTierEnvCache(env);
	}
	return decideTier({ ...args, env });
}

function throwDecisionError(decision: TierDecision): never {
	if (decision.installGuide) process.stderr.write(decision.installGuide + '\n');
	const error = decision.error!;
	throw new MeshifyError(error.code, error.message);
}
