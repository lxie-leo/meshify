import * as fs from 'node:fs';
import * as path from 'node:path';
import { warn, type MeshifyReport } from '@meshify/core';
import { readDocument } from '@meshify/kernel-ts';
import { documentToGlbBytes } from '../utils/common.js';
import type { InputFormat } from '../utils/format-detect.js';
import type { OutputManager } from '../utils/output.js';
import { writePreviewHtml, type PreviewModel } from './generate-html.js';

/**
 * Tier1 --preview-html（统一在 routeTier 收口，全命令共享）：
 * - after = manifest 里的 GLB 产物（多部件逐个装入同一视窗）
 * - before 仅 glb/gltf 输入（--tier py 场景）可视；STEP 等非 glTF 输入无浏览器渲染形态
 *   → 单视窗预览 + PREVIEW_BEFORE_UNAVAILABLE 披露（绝不静默吞掉 --preview-html）
 * - 产物非 GLB（如 convert --to stl）无对比意义 → 跳过生成 + 同码披露
 */
export interface Tier1PreviewArgs {
	input: string;
	format: InputFormat;
	om: OutputManager;
	/** Tier1 单产物路径（payload.output；multi 时为 undefined） */
	mainOutput: string | undefined;
}

export async function attachTier1Preview(report: MeshifyReport, args: Tier1PreviewArgs): Promise<void> {
	const assets = (report.output?.files ?? []).filter(
		(f) => f.role === 'asset' && f.path.toLowerCase().endsWith('.glb') && fs.existsSync(f.path),
	);
	if (assets.length === 0) {
		report.warnings.push(
			warn('PREVIEW_BEFORE_UNAVAILABLE', 'Artifact contains no GLB (e.g. target format stl/obj/ply); nothing renderable in a browser, preview page not generated'),
		);
		return;
	}

	const after: PreviewModel[] = assets.map((f) => ({
		label: assets.length > 1 ? path.basename(f.path) : 'Converted output',
		bytes: new Uint8Array(fs.readFileSync(f.path)),
	}));

	// before：glb/gltf 输入直接读；其余格式（STEP 等）没有浏览器渲染形态
	const before: PreviewModel[] = [];
	if (args.format === 'glb' || args.format === 'gltf') {
		try {
			before.push({
				label: `Input (${args.format})`,
				bytes: await documentToGlbBytes(await readDocument(args.input)),
			});
		} catch {
			// before 快照失败只影响左视窗，产物与 after 侧不受影响；披露即可
		}
	}
	if (before.length === 0) {
		report.warnings.push(
			warn(
				'PREVIEW_BEFORE_UNAVAILABLE',
				`The input is ${args.format.toUpperCase()}, which browsers cannot render; the preview page shows the artifact side only (single viewport)`,
			),
		);
	}

	const mainPath = args.mainOutput ?? assets[0].path;
	const htmlPath = args.om.claim(args.om.previewPath(mainPath));
	writePreviewHtml({ before, after, report, outPath: htmlPath });
	report.output?.files.push({ path: htmlPath, bytes: fs.statSync(htmlPath).size, role: 'preview' });
}
