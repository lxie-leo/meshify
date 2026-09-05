import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Command } from 'commander';
import { MeshifyError, EXIT_INTERNAL, EXIT_PARAM_CONFLICT, warn } from '@meshify/core';
import {
	addCommonOptions,
	documentStats,
	documentToGlbBytes,
	emitReport,
	loadInput,
	parseTierPref,
	withFailureManifest,
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
			.description('Format conversion among glb/gltf/obj/stl/ply; STEP(STP) input requires Tier1 (--tier py, or auto when installed)')
			.argument('<input>', 'input model (glb/gltf/obj/stl/ply/step/stp)')
			.option('--to <format>', 'target format: glb | gltf | obj | stl | ply (required; the default GLB artifact is the most universal)')
			.option('--up-axis <axis>', 'Up axis of the part in the STEP input: x|y|z (a leading - flips; default z = CAD convention) or auto (auto-detected from geometric features such as mounting holes; low confidence → exit 4 with candidates listed). Use it to upright parts authored lying down in the source file'),
	).action(withFailureManifest('convert', (o) => `converted-${String(o.to ?? 'glb').toLowerCase()}`, async (input: string, cmdOpts: Record<string, unknown>) => {
		const opts = cmdOpts as GlobalOptions & Record<string, unknown>;
		const startedAt = Date.now();
		const format = sniffInputFormat(input);
		parseTierPref(opts.tier);

		const to = String(opts.to ?? 'glb').toLowerCase();
		assertOutputFormat(to);
		if (to === format) {
			throw new MeshifyError(
				EXIT_PARAM_CONFLICT,
				`Input is already ${to} (${input}). Converting to the same format is meaningless; go through an intermediate format if you need re-encoding.`,
			);
		}
		// -o 扩展名必须与 --to 一致：不一致会把 STL 字节写进 .glb 名文件（坏产物留盘）
		if (opts.output !== undefined) {
			const outExt = path.extname(String(opts.output)).toLowerCase().replace('.', '');
			if (outExt !== to) {
				throw new MeshifyError(
					EXIT_PARAM_CONFLICT,
					`-o extension .${outExt || '(none)'} does not match --to ${to}; the artifact should be a .${to} file. Fix the -o path, or drop -o to use the default naming.`,
				);
			}
		}
		const params: Record<string, unknown> = { to };
		// --up-axis 仅对 STEP 有意义（其余格式浏览器/trimesh 生态默认即按 glTF 惯例处理），
		// 非 STEP 传了它必须显式拒绝——静默忽略会让用户以为朝向被处理过
		if (opts.upAxis !== undefined) {
			const upAxis = String(opts.upAxis).toLowerCase();
			if (!/^(-?[xyz]|auto)$/.test(upAxis)) {
				throw new MeshifyError(
					EXIT_PARAM_CONFLICT,
					`--up-axis must be x|y|z (optionally - prefixed to flip) or auto, got: ${opts.upAxis}`,
				);
			}
			if (format !== 'step') {
				throw new MeshifyError(
					EXIT_PARAM_CONFLICT,
					`--up-axis only applies to STEP input (this input is ${format}; other formats handle orientation per their own ecosystem conventions)`,
				);
			}
			params.up_axis = upAxis;
		}

		const op = `converted-${to}`;
		const route = await routeTier('convert', input, format, opts, { params, op, ext: to });
		if (route.handled) return;

		progress('Loading input…');
		const loaded = await loadInput(input, format);
		assertResourceLimits(loaded.bytes, loaded.inputInfo.faces, { force: !!opts.force });
		const beforeBytes = opts.previewHtml ? await documentToGlbBytes(loaded.doc) : null;

		const om = new OutputManager(input, { overwrite: !!opts.overwrite, explicit: opts.output });
		const outPath = om.claim(om.file(op, to));
		om.ensureDirFor(outPath);

		const files: ReturnType<typeof fileEntryOf>[] = [];
		const companionFiles: string[] = []; // 伴生资源（.bin/贴图/.mtl）——manifest files[] 必须齐备，Agent 按它拷产物
		progress(`Converting → ${to}…`);
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
		progressDone(`Conversion done → ${outPath}`);

		// 输出统计：obj/stl/ply 读回后统计（转换保真，指标以实际产物为准）。
		// 空场景例外：stl/ply 读取器把「0 面产物」按坏文件抛错，读回校验会把
		// 合法的空转换误报成 exit 8——convert 是结构操作，空输入 → 合法空产物 + 披露
		let afterLoaded: Awaited<ReturnType<typeof loadInput>> | null = null;
		if (loaded.inputInfo.faces === 0) {
			loaded.warnings.push(
				warn('EMPTY_SCENE_OUTPUT', 'Input is an empty scene (0 faces); the output is a valid empty file of the same format'),
			);
		} else {
			try {
				afterLoaded = await loadInput(outPath, sniffInputFormat(outPath));
			} catch (err) {
				throw new MeshifyError(
					EXIT_INTERNAL,
					`Failed to read back the converted artifact (${outPath}): ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}
		const stats = afterLoaded
			? { vertices: afterLoaded.inputInfo.vertices, faces: afterLoaded.inputInfo.faces }
			: { vertices: 0, faces: 0 };
		files.push(fileEntryOf(outPath, 'asset'));
		if (to === 'obj') {
			const mtl = path.join(path.dirname(outPath), path.basename(outPath, '.obj') + '.mtl');
			if (fs.existsSync(mtl)) files.push(fileEntryOf(mtl, 'asset'));
		}
		for (const p of companionFiles) {
			files.push(fileEntryOf(p, 'asset'));
		}

		const warnings = [...loaded.warnings, ...route.warnings, ...(afterLoaded?.warnings ?? [])];

		if (opts.previewHtml && beforeBytes) {
			progress('Generating preview page…');
			const htmlPath = om.claim(om.previewPath(outPath));
			writePreviewHtml({
				before: [{ label: `Input (${format})`, bytes: beforeBytes }],
				after: [{ label: `Converted output (${to}, read-back preview)`, bytes: await documentToGlbBytes(afterLoaded?.doc ?? loaded.doc) }],
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
			progressDone(`Preview page: ${htmlPath}`);
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
	}));
}
