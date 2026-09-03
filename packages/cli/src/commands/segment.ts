import type { Command } from 'commander';
import type { Document } from '@gltf-transform/core';
import { MeshifyError, EXIT_ALGORITHM_FAILED, EXIT_PARAM_CONFLICT } from '@meshify/core';
import {
	addCommonOptions,
	assertProcessableGeometry,
	documentStats,
	documentToGlbBytes,
	emitReport,
	loadInput,
	parseInteger,
	parseTierPref,
	parseVec3,
	type GlobalOptions,
} from '../utils/common.js';
import { sniffInputFormat } from '../utils/format-detect.js';
import { OutputManager } from '../utils/output.js';
import { routeTier } from '../utils/tier.js';
import { progress, progressDone } from '../utils/spinner.js';
import {
	assertResourceLimits,
	buildPartDocument,
	buildPlanePartsDocument,
	buildSoup,
	collectPrimitives,
	cutSoupByPlane,
	segmentConnected,
	segmentSemantic,
	writeDocument,
	type PlaneCutResult,
	type Soup,
} from '@meshify/kernel-ts';
import { writePreviewHtml } from '../preview/generate-html.js';
import { draftOf, fileEntryOf, outputOf, readBytes } from './simplify.js';

/**
 * meshify segment —— 三模式分割。
 * - connected：共享边连通域（装配体拆件首选）
 * - plane：平面切割（默认 earcut 封口保水密 = 坑 5；坑 6 碎片保留；
 *   坑 3 输出材质强制 doubleSided）
 * - semantic：法线+位置聚类（认的是「朝向+位置」而非零件语义，装配体请用 connected）
 */
export function registerSegment(program: Command): void {
	addCommonOptions(
		program
			.command('segment')
			.description('模型分割：--mode connected（连通域拆件）/ plane（平面切割+封口）/ semantic（法线位置聚类）')
			.argument('<input>', '输入模型（glb/gltf/obj/stl/ply）')
			.option('--mode <mode>', '分割模式: connected | plane | semantic（必填）')
			.option('--clusters <n>', 'semantic 聚类数（默认 8）', '8')
			.option('--axis <axis>', 'plane 模式：切割轴 x | y | z（与 --origin/--normal 二选一）')
			.option('--position <n>', 'plane 模式：切割位置 ∈ [-1,1]（线性映射包围盒两端，maestro 滑块语义）', '0')
			.option('--origin <vec3>', 'plane 模式：原生坐标系平面点 "x,y,z"（与 --axis 二选一）')
			.option('--normal <vec3>', 'plane 模式：原生坐标系平面法线 "x,y,z"（与 --axis 二选一）')
			.option('--no-cap', 'plane 模式：禁用截面封口（默认开启 earcut 封口保水密，坑 5）')
			.option('--min-faces <n>', 'connected 模式：小于该面数的碎片部件丢弃（默认 1 = 不丢）', '1'),
	).action(async (input: string, cmdOpts: Record<string, unknown>) => {
		const opts = cmdOpts as GlobalOptions & Record<string, unknown>;
		const startedAt = Date.now();
		const format = sniffInputFormat(input);
		parseTierPref(opts.tier);

		const mode = String(opts.mode ?? '');
		if (mode !== 'connected' && mode !== 'plane' && mode !== 'semantic') {
			throw new MeshifyError(EXIT_PARAM_CONFLICT, `--mode 必须是 connected | plane | semantic，收到: ${opts.mode ?? '(缺失)'}`);
		}

		const params: Record<string, unknown> = { mode };
		if (mode === 'semantic') params.clusters = parseInteger(opts.clusters, 'clusters', { min: 2, max: 64 });
		if (mode === 'connected') params.min_faces = parseInteger(opts.minFaces, 'min-faces', { min: 1 });
		if (mode === 'plane') {
			params.cap = opts.cap !== false;
			const hasAxis = opts.axis !== undefined;
			const hasOrigin = opts.origin !== undefined;
			if (hasAxis && hasOrigin) {
				throw new MeshifyError(EXIT_PARAM_CONFLICT, '--axis/--position 与 --origin/--normal 是两套互斥的平面定义，只能选一套');
			}
			if (!hasAxis && !hasOrigin) {
				throw new MeshifyError(EXIT_PARAM_CONFLICT, 'plane 模式需要 --axis x|y|z + --position，或 --origin "x,y,z" + --normal "x,y,z"');
			}
			if (hasOrigin !== (opts.normal !== undefined)) {
				throw new MeshifyError(EXIT_PARAM_CONFLICT, '--origin 与 --normal 必须成对出现');
			}
			if (hasAxis) {
				const axis = String(opts.axis).toLowerCase();
				if (axis !== 'x' && axis !== 'y' && axis !== 'z') {
					throw new MeshifyError(EXIT_PARAM_CONFLICT, `--axis 只接受 x | y | z，收到: ${opts.axis}`);
				}
				params.axis = axis;
				params.position = parseNumberStrict(opts.position, 'position', { min: -1, max: 1 });
			} else {
				params.origin = parseVec3(String(opts.origin), 'origin');
				params.normal = parseVec3(String(opts.normal), 'normal');
			}
		}

		const op = `segment-${mode}`;
		const route = await routeTier('segment', input, format, opts, { params, op, multi: true });
		if (route.handled) return;

		progress('读取输入…');
		const loaded = await loadInput(input, format);
		assertResourceLimits(loaded.bytes, loaded.inputInfo.faces, { force: !!opts.force });
		assertProcessableGeometry(loaded.inputInfo, 'segment');
		// 预览 before 快照需在内核改动 Document 之前捕获
		const beforeBytes = opts.previewHtml ? await documentToGlbBytes(loaded.doc) : null;

		progress('构建全局几何…');
		const soup = buildSoup(collectPrimitives(loaded.doc));

		let outDoc: Document;
		let partSummaries: { index: number; path: string; vertices: number; faces: number }[];
		let warnings = [...loaded.warnings, ...route.warnings];
		let tierNote: string | undefined;

		if (mode === 'connected') {
			progress('连通域分割…');
			const result = segmentConnected(soup, { minFaces: params.min_faces as number });
			warnings = warnings.concat(result.warnings);
			outDoc = buildPartDocument(loaded.doc, soup, result.parts, { doubleSided: true }); // 坑 3
			partSummaries = collectPartStats(outDoc, result.parts.length);
			tierNote = `connected: ${result.totalComponents} 连通域，输出 ${result.parts.length} 部件`;
			progressDone(`连通域分割完成：${result.totalComponents} 域 → ${result.parts.length} 部件`);
		} else if (mode === 'semantic') {
			progress('语义聚类分割…');
			const result = segmentSemantic(soup, { clusters: params.clusters as number });
			warnings = warnings.concat(result.warnings);
			outDoc = buildPartDocument(loaded.doc, soup, result.parts, { doubleSided: true });
			applyPartColors(outDoc, result.partColors);
			partSummaries = collectPartStats(outDoc, result.parts.length);
			tierNote = `semantic: ${result.totalComponents} 实体，聚类 k=${params.clusters}，输出 ${result.parts.length} 部件（认的是朝向+位置而非零件语义）`;
			progressDone(`语义分割完成：${result.parts.length} 部件`);
		} else {
			progress('平面切割…');
			const plane = resolvePlane(soup, params);
			let cut: PlaneCutResult;
			try {
				cut = cutSoupByPlane(soup, plane, { cap: params.cap as boolean });
			} catch (err) {
				throw new MeshifyError(
					EXIT_ALGORITHM_FAILED,
					`平面切割失败: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
			warnings = warnings.concat(cut.warnings);
			outDoc = buildPlanePartsDocument(loaded.doc, soup, cut, { doubleSided: true });
			partSummaries = collectPartStats(outDoc, cut.parts.length);
			tierNote = `plane: ${cut.parts.length} 部件，封口=${cut.capped}（截面法线取平面 ±n，水密按几何位置焊接）`;
			progressDone(`平面切割完成：${cut.parts.length} 部件（封口${cut.capped ? '已生成' : '未生成'}）`);
		}

		const om = new OutputManager(input, { overwrite: !!opts.overwrite, explicit: opts.output });
		const outPath = om.claim(om.file(op, 'glb'));
		om.ensureDirFor(outPath);
		await writeDocument(outDoc, outPath);
		partSummaries.forEach((p) => (p.path = outPath));

		const stats = await documentStats(outDoc);
		const files = [fileEntryOf(outPath, 'asset')];

		if (opts.previewHtml) {
			progress('生成预览页…');
			const htmlPath = om.claim(om.previewPath(outPath));
			writePreviewHtml({
				before: [{ label: '原始', bytes: beforeBytes! }],
				after: [{ label: `${mode} 分割产物`, bytes: readBytes(outPath) }],
				report: draftOf({
					command: 'segment',
					input: loaded.inputInfo,
					output: outputOf(outPath, stats, files),
					params,
					metrics: { parts: partSummaries, tier_note: tierNote },
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
				command: 'segment',
				input: loaded.inputInfo,
				output: outputOf(outPath, stats, files),
				params,
				metrics: { parts: partSummaries, tier_note: tierNote },
				warnings,
				tier: route.tier,
				durationMs: Date.now() - startedAt,
			},
			{ reportPath: opts.report ?? om.reportPath(op), json: !!opts.json },
		);
	});
}

/** --axis + --position → 世界系平面（position∈[-1,1] 线性映射包围盒两端）。 */
function resolvePlane(soup: Soup, params: Record<string, unknown>): { origin: [number, number, number]; normal: [number, number, number] } {
	if (params.origin) {
		return {
			origin: params.origin as [number, number, number],
			normal: params.normal as [number, number, number],
		};
	}
	const axis = params.axis as 'x' | 'y' | 'z';
	const position = params.position as number;
	const bbox = soupBounds(soup);
	if (!bbox) throw new MeshifyError(EXIT_ALGORITHM_FAILED, '模型无几何，无法确定切割平面');
	const ai = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
	const lo = bbox.min[ai];
	const hi = bbox.max[ai];
	const coord = lo + ((position + 1) / 2) * (hi - lo);
	const origin: [number, number, number] = [(bbox.min[0] + bbox.max[0]) / 2, (bbox.min[1] + bbox.max[1]) / 2, (bbox.min[2] + bbox.max[2]) / 2];
	origin[ai] = coord;
	const normal: [number, number, number] = [0, 0, 0];
	normal[ai] = 1;
	return { origin, normal };
}

function soupBounds(soup: Soup): { min: number[]; max: number[] } | null {
	const n = soup.positions.length / 3;
	if (n === 0) return null;
	const min = [Infinity, Infinity, Infinity];
	const max = [-Infinity, -Infinity, -Infinity];
	for (let i = 0; i < n; i++) {
		for (let k = 0; k < 3; k++) {
			const v = soup.positions[i * 3 + k];
			if (v < min[k]) min[k] = v;
			if (v > max[k]) max[k] = v;
		}
	}
	return { min, max };
}

/** semantic 部件预览着色（对齐 maestro build_semantic_preview：黄金角互斥色相）。 */
function applyPartColors(doc: Document, colors: [number, number, number][]): void {
	const scene = doc.getRoot().listScenes()[0];
	if (!scene) return;
	const nodes = scene.listChildren();
	for (let i = 0; i < nodes.length && i < colors.length; i++) {
		const mesh = nodes[i].getMesh();
		if (!mesh) continue;
		const mat = doc
			.createMaterial(`${nodes[i].getName() ?? 'part'}_color`)
			.setBaseColorFactor([colors[i][0], colors[i][1], colors[i][2], 1])
			.setDoubleSided(true);
		for (const prim of mesh.listPrimitives()) prim.setMaterial(mat);
	}
}

/** 输出 Document 逐部件统计（节点顺序 = part_000…）。 */
function collectPartStats(doc: Document, partCount: number): { index: number; path: string; vertices: number; faces: number }[] {
	const out: { index: number; path: string; vertices: number; faces: number }[] = [];
	const scene = doc.getRoot().listScenes()[0];
	if (!scene) return out;
	const nodes = scene.listChildren();
	for (let i = 0; i < nodes.length && i < partCount; i++) {
		const mesh = nodes[i].getMesh();
		if (!mesh) continue;
		let vertices = 0;
		let faces = 0;
		for (const prim of mesh.listPrimitives()) {
			const pos = prim.getAttribute('POSITION');
			const idx = prim.getIndices();
			vertices += pos ? pos.getCount() : 0;
			faces += idx ? idx.getCount() / 3 : (pos ? pos.getCount() : 0) / 3;
		}
		out.push({ index: i, path: '', vertices, faces });
	}
	return out;
}

function parseNumberStrict(raw: unknown, name: string, opts: { min?: number; max?: number }): number {
	const n = Number(raw);
	if (!Number.isFinite(n)) throw new MeshifyError(EXIT_PARAM_CONFLICT, `--${name} 需要数字，收到: ${raw}`);
	if (opts.min !== undefined && n < opts.min) throw new MeshifyError(EXIT_PARAM_CONFLICT, `--${name} 必须 ≥ ${opts.min}，收到: ${n}`);
	if (opts.max !== undefined && n > opts.max) throw new MeshifyError(EXIT_PARAM_CONFLICT, `--${name} 必须 ≤ ${opts.max}，收到: ${n}`);
	return n;
}
