import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Command } from 'commander';
import { MeshifyError, EXIT_INPUT_UNREADABLE, EXIT_PARAM_CONFLICT, warn } from '@meshify/core';
import type { Texture } from '@gltf-transform/core';
import {
	addCommonOptions,
	documentStats,
	documentToGlbBytes,
	emitReport,
	loadInput,
	parseNumber,
	parseTierPref,
	type GlobalOptions,
} from '../utils/common.js';
import { sniffInputFormat } from '../utils/format-detect.js';
import { OutputManager } from '../utils/output.js';
import { routeTier } from '../utils/tier.js';
import { progress, progressDone } from '../utils/spinner.js';
import {
	assertResourceLimits,
	normalizeImage,
	textureDocument,
	writeDocument,
	type TextureMode,
} from '@meshify/kernel-ts';
import { writePreviewHtml } from '../preview/generate-html.js';
import { draftOf, fileEntryOf, outputOf, readBytes } from './simplify.js';

/**
 * meshify texture —— 五种 UV 投影重生成（+ 可选贴图绑定）。
 * - mode=uv 且子网格缺 UV → 自动盒式 + AUTO_BOX_UV_GENERATED（不静默）
 * - --image 附着 baseColor 贴图（统一转 PNG/JPEG，glTF 核心规范只认这两种）
 * - 圆柱/球面接缝顶点 u 可出 [0,1] → 采样器 REPEAT
 */
export function registerTexture(program: Command): void {
	addCommonOptions(
		program
			.command('texture')
			.description('UV 投影重生成（planar/cylindrical/spherical/box/uv）+ 可选 --image 绑定 baseColor 贴图')
			.argument('<input>', '输入模型（glb/gltf/obj/stl/ply）')
			.option('--map <mode>', '投影模式: planar | cylindrical | spherical | box | uv（必填）')
			.option('--image <path>', 'baseColor 贴图文件（png/jpeg/webp/…，自动规范化）')
			.option('--metallic <n>', '覆盖材质金属度 (0-1)')
			.option('--roughness <n>', '覆盖材质粗糙度 (0-1)'),
	).action(async (input: string, cmdOpts: Record<string, unknown>) => {
		const opts = cmdOpts as GlobalOptions & Record<string, unknown>;
		const startedAt = Date.now();
		const format = sniffInputFormat(input);
		parseTierPref(opts.tier);

		const mode = String(opts.map ?? '');
		if (!['planar', 'cylindrical', 'spherical', 'box', 'uv'].includes(mode)) {
			throw new MeshifyError(
				EXIT_PARAM_CONFLICT,
				`--map 必须是 planar | cylindrical | spherical | box | uv，收到: ${opts.map ?? '(缺失)'}`,
			);
		}
		const params: Record<string, unknown> = { map: mode };
		if (opts.image !== undefined) {
			// 贴图路径进 payload 时转绝对（Tier1 子进程 cwd 不同）
			params.image = path.resolve(String(opts.image));
		}
		if (opts.metallic !== undefined) params.metallic = parseNumber(opts.metallic, 'metallic', { min: 0, max: 1 });
		if (opts.roughness !== undefined) params.roughness = parseNumber(opts.roughness, 'roughness', { min: 0, max: 1 });
		if (opts.image !== undefined && mode === 'uv') {
			throw new MeshifyError(
				EXIT_PARAM_CONFLICT,
				'--map uv 表示保留现有 UV，与 --image（要求重投影绑定贴图）语义冲突；请改用其他投影模式',
			);
		}

		const route = await routeTier('texture', input, format, opts, { params, op: 'textured' });
		if (route.handled) return;

		progress('读取输入…');
		const loaded = await loadInput(input, format);
		assertResourceLimits(loaded.bytes, loaded.inputInfo.faces, { force: !!opts.force });
		const beforeBytes = opts.previewHtml ? await documentToGlbBytes(loaded.doc) : null;

		progress(`UV 投影（${mode}）…`);
		const result = textureDocument(loaded.doc, { mode: mode as TextureMode });
		const warnings = [...loaded.warnings, ...route.warnings, ...result.warnings];

		if (opts.image !== undefined) {
			progress('绑定贴图…');
			attachBaseColorImage(loaded.doc, String(opts.image), mode, warnings);
		}
		if (params.metallic !== undefined || params.roughness !== undefined) {
			for (const mat of loaded.doc.getRoot().listMaterials()) {
				if (params.metallic !== undefined) mat.setMetallicFactor(params.metallic as number);
				if (params.roughness !== undefined) mat.setRoughnessFactor(params.roughness as number);
			}
		}
		progressDone(`UV 重生成完成（${result.meshes.length} 子网格）`);

		const om = new OutputManager(input, { overwrite: !!opts.overwrite, explicit: opts.output });
		const outPath = om.claim(om.file('textured', 'glb'));
		om.ensureDirFor(outPath);
		await writeDocument(loaded.doc, outPath);

		const stats = await documentStats(loaded.doc);
		const files = [fileEntryOf(outPath, 'asset')];

		if (opts.previewHtml && beforeBytes) {
			progress('生成预览页…');
			const htmlPath = om.claim(om.previewPath(outPath));
			writePreviewHtml({
				before: [{ label: '原始', bytes: beforeBytes }],
				after: [{ label: '贴图产物', bytes: readBytes(outPath) }],
				report: draftOf({
					command: 'texture',
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
				command: 'texture',
				input: loaded.inputInfo,
				output: outputOf(outPath, stats, files),
				params,
				warnings,
				tier: route.tier,
				durationMs: Date.now() - startedAt,
			},
			{ reportPath: opts.report ?? om.reportPath('textured'), json: !!opts.json },
		);
	});
}

/** 读贴图文件 → 规范化为 PNG/JPEG（glTF 核心只认这两种）→ 全材质绑定 baseColor。 */
async function attachBaseColorImage(
	doc: Parameters<typeof textureDocument>[0],
	imagePath: string,
	mode: string,
	warnings: ReturnType<typeof textureDocument>['warnings'],
): Promise<void> {
	let raw: Uint8Array;
	try {
		raw = new Uint8Array(fs.readFileSync(imagePath));
	} catch (err) {
		throw new MeshifyError(
			EXIT_INPUT_UNREADABLE,
			`--image 贴图不可读: ${imagePath}（${err instanceof Error ? err.message : String(err)}）`,
		);
	}
	const normalized = await normalizeImage(raw);
	if (normalized.converted) {
		warnings.push(
			warn(
				'TEXTURE_DOWNSCALED',
				`贴图 ${path.basename(imagePath)} 非 PNG/JPEG，已规范化转 PNG（glTF 核心规范只内建这两种位图格式）`,
			),
		);
	}

	const texture: Texture = doc
		.createTexture(path.basename(imagePath))
		.setImage(normalized.bytes)
		.setMimeType(normalized.mime);

	// STL 等无材质输入：给每个 primitive 兜底建材质，保证贴图有落点
	const root = doc.getRoot();
	const prims = root.listMeshes().flatMap((m) => m.listPrimitives());
	let fallback = null;
	if (prims.some((p) => !p.getMaterial()) && root.listMaterials().length === 0) {
		fallback = doc.createMaterial('meshify_default');
	}
	for (const prim of prims) {
		if (!prim.getMaterial()) prim.setMaterial(fallback ?? root.listMaterials()[0]);
	}
	for (const mat of root.listMaterials()) {
		mat.setBaseColorTexture(texture);
		// 圆柱/球面接缝处理会产生出界 u → REPEAT 采样。
		// 4.5 中 wrap 挂在 TextureInfo（材质槽位）而非 Texture 上。
		if (mode === 'cylindrical' || mode === 'spherical') {
			mat.getBaseColorTextureInfo()?.setWrapS(10497).setWrapT(33071); // REPEAT / CLAMP_TO_EDGE
		}
	}
}
