import * as fs from 'node:fs';
import type { Command } from 'commander';
import {
	EXIT_CODES,
	MeshifyError,
	generateReport,
	type FileInfo,
	type InputInfo,
	type MeshifyReport,
	type ReportWarning,
	type Tier,
} from '@meshify/core';
import {
	addCommonOptions,
	assertProcessableGeometry,
	documentStats,
	documentToGlbBytes,
	emitReport,
	loadInput,
	parseInteger,
	parseNumber,
	parseTierPref,
	withFailureManifest,
	type GlobalOptions,
} from '../utils/common.js';
import { sniffInputFormat } from '../utils/format-detect.js';
import { OutputManager } from '../utils/output.js';
import { routeTier } from '../utils/tier.js';
import { progress, progressDone } from '../utils/spinner.js';
import { assertResourceLimits, simplifyDocument, writeDocument } from '@meshify/kernel-ts';
import { writePreviewHtml } from '../preview/generate-html.js';

/**
 * meshify simplify —— QEM 减面。
 * 坑资产：坑 1（材质结构性不丢）/ 坑 12（< min-faces 跳过 + SMALL_MESH_SKIPPED）。
 */
export function registerSimplify(program: Command): void {
	addCommonOptions(
		program
			.command('simplify')
			.description('QEM decimation (meshopt WASM): per-submesh by default to keep materials; submeshes under --min-faces are skipped')
			.argument('<input>', 'input model (glb/gltf/obj/stl/ply)')
			.option('--ratio <n>', 'target fraction of faces kept, (0,1], default 0.5')
			.option('--target-faces <n>', 'target face count (absolute; mutually exclusive with --ratio)')
			.option('--error <n>', 'simplification error bound (normalized, default 0.01; the actual error is in the manifest)', '0.01')
			.option('--no-keep-border', 'do not lock border vertices (open-shell borders may collapse)')
			.option('--merge', 'merge same-material submeshes before simplifying (per-submesh by default)')
			.option('--min-faces <n>', 'skip submeshes below this face count (default 200, pitfall 12)', '200')
			.option('--aggressiveness <n>', 'Tier1 pyfqmr semantic parameter (echoed only on Tier0)', '7'),
	).action(withFailureManifest('simplify', 'simplified', async (input: string, cmdOpts: Record<string, unknown>) => {
		const opts = cmdOpts as GlobalOptions & Record<string, unknown>;
		const startedAt = Date.now();
		const format = sniffInputFormat(input);
		parseTierPref(opts.tier);

		// 互斥契约：显式 --ratio 与 --target-faces 二选一（缺省 ratio 不算冲突）
		if (opts.targetFaces !== undefined && opts.ratio !== undefined) {
			throw new MeshifyError(EXIT_CODES.EXIT_PARAM_CONFLICT, '--ratio and --target-faces are mutually exclusive; pick one');
		}

		const params: Record<string, unknown> = {
			ratio: parseNumber(opts.ratio ?? '0.5', 'ratio', { min: 1e-6, max: 1 }),
			error: parseNumber(opts.error, 'error', { min: 1e-6, max: 1 }),
			keep_border: opts.keepBorder !== false,
			per_mesh: opts.merge !== true,
			min_faces: parseInteger(opts.minFaces, 'min-faces', { min: 1 }),
			aggressiveness: parseInteger(opts.aggressiveness, 'aggressiveness', { min: 1, max: 20 }),
		};
		if (opts.targetFaces !== undefined) {
			params.target_faces = parseInteger(opts.targetFaces, 'target-faces', { min: 1 });
		}

		// STEP 或显式 --tier py → Tier1（pyfqmr）；否则 Tier0
		const route = await routeTier('simplify', input, format, opts, { params, op: 'simplified' });
		if (route.handled) return;

		progress('Loading input…');
		const loaded = await loadInput(input, format);
		assertResourceLimits(loaded.bytes, loaded.inputInfo.faces, { force: !!opts.force });
		assertProcessableGeometry(loaded.inputInfo, 'simplify');
		// 预览 before 快照需在内核改动 Document 之前捕获
		const beforeBytes = opts.previewHtml ? await documentToGlbBytes(loaded.doc) : null;

		progress('Simplifying (QEM)…');
		const result = await simplifyDocument(loaded.doc, {
			ratio: params.ratio as number,
			targetFaces: params.target_faces as number | undefined,
			error: params.error as number,
			keepBorder: params.keep_border as boolean,
			perMesh: params.per_mesh as boolean,
			minFaces: params.min_faces as number,
		});

		const om = new OutputManager(input, { overwrite: !!opts.overwrite, explicit: opts.output });
		const outPath = om.claim(om.file('simplified', 'glb'));
		om.ensureDirFor(outPath);
		await writeDocument(loaded.doc, outPath);
		progressDone(`Simplify done: ${result.facesBefore} → ${result.facesAfter} faces`);

		const stats = await documentStats(loaded.doc);
		const warnings = [...loaded.warnings, ...route.warnings, ...result.warnings];
		const files: FileInfo[] = [fileEntryOf(outPath, 'asset')];

		if (opts.previewHtml) {
			progress('Generating preview page…');
			const htmlPath = om.claim(om.previewPath(outPath));
			writePreviewHtml({
				before: [{ label: 'Input', bytes: beforeBytes! }],
				after: [{ label: 'Simplified output', bytes: readBytes(outPath) }],
				report: draftOf({
					command: 'simplify',
					input: loaded.inputInfo,
					output: outputOf(outPath, stats, files),
					params,
					metrics: { max_error_normalized: result.maxErrorNormalized },
					warnings,
					errors: result.errors,
					tier: route.tier,
					durationMs: Date.now() - startedAt,
				}),
				outPath: htmlPath,
			});
			files.push(fileEntryOf(htmlPath, 'preview'));
			progressDone(`Preview page: ${htmlPath}`);
		}

		emitReport(
			{
				command: 'simplify',
				input: loaded.inputInfo,
				output: outputOf(outPath, stats, files),
				params,
				metrics: { max_error_normalized: result.maxErrorNormalized },
				warnings,
				errors: result.errors,
				exitCode: result.partial ? 7 : 0,
				tier: route.tier,
				durationMs: Date.now() - startedAt,
			},
			{ reportPath: opts.report ?? om.reportPath('simplified'), json: !!opts.json },
		);
	}));
}

// ---- 命令间小工具（避免每命令重复样板） ----

export function fileEntryOf(p: string, role: FileInfo['role']): FileInfo {
	return { path: p, bytes: fs.statSync(p).size, role };
}

export function readBytes(p: string): Uint8Array {
	return new Uint8Array(fs.readFileSync(p));
}

export function outputOf(
	path: string,
	stats: { vertices: number; faces: number },
	files: FileInfo[],
	format = 'glb',
): {
	path: string;
	format: string;
	bytes: number;
	vertices: number;
	faces: number;
	files: FileInfo[];
} {
	return {
		path,
		format,
		bytes: fs.statSync(path).size,
		vertices: stats.vertices,
		faces: stats.faces,
		files,
	};
}

/** 预览页需要先于 emit 拿到 report 对象（generateReport 纯组装，不落盘）。 */
export function draftOf(src: {
	command: string;
	input: InputInfo;
	output: Parameters<typeof generateReport>[0]['output'];
	params: Record<string, unknown>;
	metrics?: Record<string, unknown>;
	warnings: ReportWarning[];
	errors?: string[];
	tier: Tier;
	durationMs: number;
}): MeshifyReport {
	return generateReport({
		command: src.command,
		input: src.input,
		output: src.output,
		params: src.params,
		metrics: src.metrics,
		warnings: src.warnings,
		errors: src.errors,
		tier: src.tier,
		durationMs: src.durationMs,
	});
}
