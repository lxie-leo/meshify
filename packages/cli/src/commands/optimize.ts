import type { Command } from 'commander';
import { MeshifyError, EXIT_PARAM_CONFLICT } from '@meshify/core';
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
import {
	assertResourceLimits,
	optimizeDocument,
	writeDocument,
	type OptimizeCodec,
	type OptimizeTextureFormat,
} from '@meshify/kernel-ts';
import { writePreviewHtml } from '../preview/generate-html.js';
import { draftOf, fileEntryOf, outputOf, readBytes } from './simplify.js';

/**
 * meshify optimize —— 一体化 Web 交付管线。
 * dedup → prune →（可选简化）→（可选贴图 WebP 压缩/降采样，坑 11 披露）
 * → meshopt/draco 几何压缩（默认 meshopt；draco 需可选依赖，缺失时 DRACO_UNAVAILABLE 披露）。
 */
export function registerOptimize(program: Command): void {
	addCommonOptions(
		program
			.command('optimize')
			.description('Web 交付一键优化：去重/修剪 + 可选简化 + 贴图压缩 + meshopt|draco 几何压缩')
			.argument('<input>', '输入模型（glb/gltf/obj/stl/ply）')
			.option('--ratio <n>', '简化保留面比例（缺省 = 不简化）')
			.option('--error <n>', '简化误差上限（归一化，默认 0.01）', '0.01')
			.option('--compression <codec>', '几何压缩: meshopt | draco | none（默认 meshopt）', 'meshopt')
			.option('--texture-format <fmt>', '贴图格式: webp | jpeg | png | none（默认 webp；none = 不动贴图）', 'webp')
			.option('--texture-size <n>', '贴图最长边上限（超出自动降采样，坑 11）')
			.option('--min-faces <n>', '小于该面数的子网格跳过简化（默认 200）', '200'),
	).action(withFailureManifest('optimize', 'optimized', async (input: string, cmdOpts: Record<string, unknown>) => {
		const opts = cmdOpts as GlobalOptions & Record<string, unknown>;
		const startedAt = Date.now();
		const format = sniffInputFormat(input);
		parseTierPref(opts.tier);

		const codec = String(opts.compression ?? 'meshopt').toLowerCase();
		if (codec !== 'meshopt' && codec !== 'draco' && codec !== 'none') {
			throw new MeshifyError(EXIT_PARAM_CONFLICT, `--compression 只接受 meshopt | draco | none，收到: ${opts.compression}`);
		}
		const texFmtRaw = String(opts.textureFormat ?? 'webp').toLowerCase();
		if (!['webp', 'jpeg', 'png', 'none'].includes(texFmtRaw)) {
			throw new MeshifyError(EXIT_PARAM_CONFLICT, `--texture-format 只接受 webp | jpeg | png | none，收到: ${opts.textureFormat}`);
		}

		const params: Record<string, unknown> = {
			compression: codec,
			texture_format: texFmtRaw,
			error: parseNumber(opts.error, 'error', { min: 1e-6, max: 1 }),
			min_faces: parseInteger(opts.minFaces, 'min-faces', { min: 1 }),
		};
		if (opts.ratio !== undefined) params.ratio = parseNumber(opts.ratio, 'ratio', { min: 0.01, max: 1 });
		if (opts.textureSize !== undefined) {
			params.max_texture_size = parseInteger(opts.textureSize, 'texture-size', { min: 16, max: 16384 });
		}

		const route = await routeTier('optimize', input, format, opts, { params, op: 'optimized' });
		if (route.handled) return;

		progress('读取输入…');
		const loaded = await loadInput(input, format);
		assertResourceLimits(loaded.bytes, loaded.inputInfo.faces, { force: !!opts.force });
		assertProcessableGeometry(loaded.inputInfo, 'optimize');
		const beforeBytes = opts.previewHtml ? await documentToGlbBytes(loaded.doc) : null;

		progress('优化管线执行中…');
		const result = await optimizeDocument(loaded.doc, {
			ratio: params.ratio as number | undefined,
			error: params.error as number,
			minFaces: params.min_faces as number,
			textureFormat: (texFmtRaw === 'none' ? null : texFmtRaw) as OptimizeTextureFormat | null,
			textureSize: params.max_texture_size as number | undefined,
			codec: codec as OptimizeCodec,
		});
		progressDone(`优化完成 ${result.facesBefore} → ${result.facesAfter} 面（codec=${result.codecApplied}）`);

		const om = new OutputManager(input, { overwrite: !!opts.overwrite, explicit: opts.output });
		const outPath = om.claim(om.file('optimized', 'glb'));
		om.ensureDirFor(outPath);
		await writeDocument(loaded.doc, outPath);

		const stats = await documentStats(loaded.doc);
		const warnings = [...loaded.warnings, ...route.warnings, ...result.warnings];
		const files = [fileEntryOf(outPath, 'asset')];

		if (opts.previewHtml && beforeBytes) {
			progress('生成预览页…');
			const htmlPath = om.claim(om.previewPath(outPath));
			writePreviewHtml({
				before: [{ label: '原始', bytes: beforeBytes }],
				after: [{ label: '优化产物', bytes: readBytes(outPath) }],
				report: draftOf({
					command: 'optimize',
					input: loaded.inputInfo,
					output: outputOf(outPath, stats, files),
					params,
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
				command: 'optimize',
				input: loaded.inputInfo,
				output: outputOf(outPath, stats, files),
				params,
				warnings,
				tier: route.tier,
				durationMs: Date.now() - startedAt,
			},
			{ reportPath: opts.report ?? om.reportPath('optimized'), json: !!opts.json },
		);
	}));
}
