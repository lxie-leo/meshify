import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Command } from 'commander';
import { MeshifyError, EXIT_INTERNAL, EXIT_PARAM_CONFLICT } from '@meshify/core';
import {
	addCommonOptions,
	documentStats,
	documentToGlbBytes,
	emitReport,
	loadInput,
	parseTierPref,
	type GlobalOptions,
} from '../utils/common.js';
import { assertOutputFormat, sniffInputFormat } from '../utils/format-detect.js';
import { OutputManager } from '../utils/output.js';
import { routeTier } from '../utils/tier.js';
import { progress, progressDone } from '../utils/spinner.js';
import {
	assertResourceLimits,
	documentToObj,
	documentToPly,
	documentToStl,
	writeDocument,
} from '@meshify/kernel-ts';
import { writePreviewHtml } from '../preview/generate-html.js';
import { draftOf, fileEntryOf, outputOf, readBytes } from './simplify.js';

/**
 * meshify convert —— 格式互转（glb/gltf/obj/stl/ply；step 读入走 Tier1）。
 * OBJ→GLB 等价材质自动合并（坑 1 相关：材质不丢、冗余合并 + MATERIALS_MERGED 披露）。
 */
export function registerConvert(program: Command): void {
	addCommonOptions(
		program
			.command('convert')
			.description('格式转换：glb/gltf/obj/stl/ply 互转；STEP(STP) 读入需 Tier1（--tier py 或已安装时 auto）')
			.argument('<input>', '输入模型（glb/gltf/obj/stl/ply/step/stp）')
			.option('--to <format>', '目标格式: glb | gltf | obj | stl | ply（必填，默认产物 GLB 最通用）'),
	).action(async (input: string, cmdOpts: Record<string, unknown>) => {
		const opts = cmdOpts as GlobalOptions & Record<string, unknown>;
		const startedAt = Date.now();
		const format = sniffInputFormat(input);
		parseTierPref(opts.tier);

		const to = String(opts.to ?? 'glb').toLowerCase();
		assertOutputFormat(to);
		if (to === format) {
			throw new MeshifyError(
				EXIT_PARAM_CONFLICT,
				`输入已是 ${to} 格式（${input}）。转换到同格式无意义；如需重新编码请先转中间格式。`,
			);
		}
		// -o 扩展名必须与 --to 一致：不一致会把 STL 字节写进 .glb 名文件（坏产物留盘）
		if (opts.output !== undefined) {
			const outExt = path.extname(String(opts.output)).toLowerCase().replace('.', '');
			if (outExt !== to) {
				throw new MeshifyError(
					EXIT_PARAM_CONFLICT,
					`-o 输出扩展名 .${outExt || '(无)'} 与 --to ${to} 不一致，产物应是 .${to} 文件。请修正 -o 路径或去掉 -o 用默认命名。`,
				);
			}
		}
		const params: Record<string, unknown> = { to };

		const op = `converted-${to}`;
		const route = await routeTier('convert', input, format, opts, { params, op, ext: to });
		if (route.handled) return;

		progress('读取输入…');
		const loaded = await loadInput(input, format);
		assertResourceLimits(loaded.bytes, loaded.inputInfo.faces, { force: !!opts.force });
		const beforeBytes = opts.previewHtml ? await documentToGlbBytes(loaded.doc) : null;

		const om = new OutputManager(input, { overwrite: !!opts.overwrite, explicit: opts.output });
		const outPath = om.claim(om.file(op, to));
		om.ensureDirFor(outPath);

		const files: ReturnType<typeof fileEntryOf>[] = [];
		const companionFiles: string[] = []; // 伴生资源（.bin/贴图/.mtl）——manifest files[] 必须齐备，Agent 按它拷产物
		progress(`转换 → ${to}…`);
		if (to === 'glb' || to === 'gltf') {
			await writeDocument(loaded.doc, outPath);
			if (to === 'gltf') {
				// 解析产物 JSON，收集外部 buffer/贴图 URI（gltf-transform 写 .gltf 时按需外置）
				const written = JSON.parse(fs.readFileSync(outPath, 'utf-8')) as {
					buffers?: { uri?: string }[];
					images?: { uri?: string }[];
				};
				const uris = [
					...(written.buffers ?? []).map((b) => b.uri),
					...(written.images ?? []).map((i) => i.uri),
				];
				for (const uri of uris) {
					if (!uri || uri.startsWith('data:')) continue;
					const p = path.resolve(path.dirname(outPath), decodeURIComponent(uri));
					if (fs.existsSync(p)) companionFiles.push(p);
				}
			}
		} else if (to === 'stl') {
			fs.writeFileSync(outPath, documentToStl(loaded.doc));
		} else if (to === 'ply') {
			fs.writeFileSync(outPath, documentToPly(loaded.doc), 'utf-8');
		} else {
			// OBJ：主文件 + .mtl + 伴生贴图
			const exported = await documentToObj(loaded.doc, { mtlName: path.basename(outPath, '.obj') + '.mtl' });
			fs.writeFileSync(outPath, exported.obj, 'utf-8');
			if (exported.mtl) fs.writeFileSync(path.join(path.dirname(outPath), path.basename(outPath, '.obj') + '.mtl'), exported.mtl, 'utf-8');
			for (const img of exported.images) {
				fs.writeFileSync(path.join(path.dirname(outPath), img.name), img.bytes);
				companionFiles.push(path.join(path.dirname(outPath), img.name));
			}
		}
		progressDone(`转换完成 → ${outPath}`);

		// 输出统计：obj/stl/ply 读回后统计（转换保真，指标以实际产物为准）
		let afterLoaded: Awaited<ReturnType<typeof loadInput>>;
		try {
			afterLoaded = await loadInput(outPath, sniffInputFormat(outPath));
		} catch (err) {
			throw new MeshifyError(
				EXIT_INTERNAL,
				`转换产物读回失败（${outPath}）: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		const stats = { vertices: afterLoaded.inputInfo.vertices, faces: afterLoaded.inputInfo.faces };
		files.push(fileEntryOf(outPath, 'asset'));
		if (to === 'obj') {
			const mtl = path.join(path.dirname(outPath), path.basename(outPath, '.obj') + '.mtl');
			if (fs.existsSync(mtl)) files.push(fileEntryOf(mtl, 'asset'));
		}
		for (const p of companionFiles) {
			files.push(fileEntryOf(p, 'asset'));
		}

		const warnings = [...loaded.warnings, ...route.warnings, ...afterLoaded.warnings];

		if (opts.previewHtml && beforeBytes) {
			progress('生成预览页…');
			const htmlPath = om.claim(om.previewPath(outPath));
			writePreviewHtml({
				before: [{ label: `原始（${format}）`, bytes: beforeBytes }],
				after: [{ label: `转换产物（${to}，读回预览）`, bytes: await documentToGlbBytes(afterLoaded.doc) }],
				report: draftOf({
					command: 'convert',
					input: loaded.inputInfo,
					output: outputOf(outPath, stats, files, to),
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
				command: 'convert',
				input: loaded.inputInfo,
				output: outputOf(outPath, stats, files, to),
				params,
				warnings,
				tier: route.tier,
				durationMs: Date.now() - startedAt,
			},
			{ reportPath: opts.report ?? om.reportPath(op), json: !!opts.json },
		);
	});
}
