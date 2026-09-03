import * as fs from 'node:fs';
import type { Command } from 'commander';
import type { LodLevelSummary } from '@meshify/core';
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
	type GlobalOptions,
} from '../utils/common.js';
import { sniffInputFormat } from '../utils/format-detect.js';
import { OutputManager } from '../utils/output.js';
import { routeTier } from '../utils/tier.js';
import { progress, progressDone } from '../utils/spinner.js';
import { assertResourceLimits, generateLodLevels, writeDocument } from '@meshify/kernel-ts';
import { writePreviewHtml } from '../preview/generate-html.js';
import { draftOf, fileEntryOf, readBytes } from './simplify.js';

/**
 * meshify lod —— 多级 LOD 链。
 * lod_0 原样；lod_i = 源文档深克隆后按 ratio^i 独立简化（不级联，误差不复利），
 * i≥1 附加 meshopt 无损容器压缩（dedup/prune 顺带清理）。
 */
export function registerLod(program: Command): void {
	addCommonOptions(
		program
			.command('lod')
			.description('多级 LOD 链：lod_0 原样 + lod_i 按 --ratio^i 逐级简化（每级独立文件）')
			.argument('<input>', '输入模型（glb/gltf/obj/stl/ply）')
			.option('--levels <n>', '级数（含 lod_0，≥2，默认 3）', '3')
			.option('--ratio <n>', '每级保留面比例（几何级数，默认 0.5 → 100%/50%/25%）', '0.5')
			.option('--error <n>', '简化误差上限（归一化，默认 0.01）', '0.01')
			.option('--min-faces <n>', '小于该面数的子网格跳过简化（默认 200）', '200'),
	).action(async (input: string, cmdOpts: Record<string, unknown>) => {
		const opts = cmdOpts as GlobalOptions & Record<string, unknown>;
		const startedAt = Date.now();
		const format = sniffInputFormat(input);
		parseTierPref(opts.tier);

		const levels = parseInteger(opts.levels, 'levels', { min: 2, max: 16 });
		const ratio = parseNumber(opts.ratio, 'ratio', { min: 0.01, max: 0.99 });
		const params: Record<string, unknown> = {
			levels,
			ratio,
			error: parseNumber(opts.error, 'error', { min: 1e-6, max: 1 }),
			min_faces: parseInteger(opts.minFaces, 'min-faces', { min: 1 }),
		};

		// Tier1 路线为多文件输出（output_dir/part_%03d.glb，manifest 内逐级披露路径）
		const route = await routeTier('lod', input, format, opts, { params, op: 'lod', multi: true });
		if (route.handled) return;

		progress('读取输入…');
		const loaded = await loadInput(input, format);
		assertResourceLimits(loaded.bytes, loaded.inputInfo.faces, { force: !!opts.force });
		assertProcessableGeometry(loaded.inputInfo, 'lod');
		const beforeBytes = opts.previewHtml ? await documentToGlbBytes(loaded.doc) : null;

		progress(`生成 LOD 链（${levels} 级）…`);
		const result = await generateLodLevels(loaded.doc, {
			levels,
			ratio,
			error: params.error as number,
			minFaces: params.min_faces as number,
		});
		const warnings = [...loaded.warnings, ...route.warnings, ...result.warnings];

		const om = new OutputManager(input, { overwrite: !!opts.overwrite, explicit: opts.output });
		const lodSummaries: LodLevelSummary[] = [];
		const files: ReturnType<typeof fileEntryOf>[] = [];
		for (const level of result.levels) {
			const p = om.claim(om.file(`lod${level.level}`, 'glb'));
			om.ensureDirFor(p);
			await writeDocument(level.document, p);
			lodSummaries.push({
				level: level.level,
				path: p,
				faces: level.faces,
				vertices: level.vertices,
				bytes: fs.statSync(p).size,
				ratio: level.ratio,
			});
			files.push(fileEntryOf(p, 'lod'));
		}
		progressDone(`LOD 链完成：${lodSummaries.map((l) => `L${l.level}:${l.faces}`).join('，')}`);

		const main = lodSummaries[0];
		const totalBytes = lodSummaries.reduce((s, l) => s + l.bytes, 0);
		const stats = await documentStats(result.levels[0].document);

		if (opts.previewHtml && beforeBytes) {
			progress('生成预览页…');
			const htmlPath = om.claim(om.previewPath(main.path));
			writePreviewHtml({
				before: [{ label: '原始', bytes: beforeBytes }],
				after: result.levels.slice(1).map((l) => ({ label: `LOD${l.level}（${Math.round(l.ratio * 100)}%）`, bytes: readBytes(lodSummaries[l.level].path) })),
				report: draftOf({
					command: 'lod',
					input: loaded.inputInfo,
					output: {
						path: main.path,
						format: 'glb',
						bytes: totalBytes,
						vertices: stats.vertices,
						faces: stats.faces,
						files,
					},
					params,
					metrics: { lod_levels: lodSummaries },
					warnings,
					tier: route.tier,
					durationMs: Date.now() - startedAt,
				}),
				outPath: htmlPath,
			});
			files.push(fileEntryOf(htmlPath, 'preview'));
			progressDone(`预览页 ${htmlPath}`);
		}

		emitReport(
			{
				command: 'lod',
				input: loaded.inputInfo,
				output: {
					path: main.path,
					format: 'glb',
					bytes: totalBytes,
					vertices: stats.vertices,
					faces: stats.faces,
					files,
				},
				params,
				metrics: { lod_levels: lodSummaries },
				warnings,
				tier: route.tier,
				durationMs: Date.now() - startedAt,
			},
			{ reportPath: opts.report ?? om.reportPath('lod'), json: !!opts.json },
		);
	});
}
