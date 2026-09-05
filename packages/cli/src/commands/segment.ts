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
	withFailureManifest,
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
			.description('Split a model: --mode connected (connected components) / plane (plane cut + capping) / semantic (normal+position clustering)')
			.argument('<input>', 'input model (glb/gltf/obj/stl/ply)')
			.option('--mode <mode>', 'segmentation mode: connected | plane | semantic (required)')
			.option('--clusters <n>', 'semantic cluster count (default 8)', '8')
			.option('--axis <axis>', 'plane mode: cut axis x | y | z (mutually exclusive with --origin/--normal)')
			.option('--position <n>', 'plane mode: cut position ∈ [-1,1] (linearly mapped across the bbox; maestro slider semantics)', '0')
			.option('--origin <vec3>', 'plane mode: plane point "x,y,z" in native coordinates (mutually exclusive with --axis)')
			.option('--normal <vec3>', 'plane mode: plane normal "x,y,z" in native coordinates (mutually exclusive with --axis)')
			.option('--no-cap', 'plane mode: disable cross-section capping (earcut capping for watertightness is on by default, pitfall 5)')
			.option('--min-faces <n>', 'connected mode: drop fragment parts below this face count (default 1 = drop nothing)', '1'),
		// op 段含 --mode 原始值：早失败时（mode 校验自身抛错）也能落对报告名（wrapper 内净化）
	).action(withFailureManifest('segment', (o) => `segment-${String(o.mode ?? 'unknown')}`, async (input: string, cmdOpts: Record<string, unknown>) => {
		const opts = cmdOpts as GlobalOptions & Record<string, unknown>;
		const startedAt = Date.now();
		const format = sniffInputFormat(input);
		parseTierPref(opts.tier);

		const mode = String(opts.mode ?? '');
		if (mode !== 'connected' && mode !== 'plane' && mode !== 'semantic') {
			throw new MeshifyError(EXIT_PARAM_CONFLICT, `--mode must be connected | plane | semantic, got: ${opts.mode ?? '(missing)'}`);
		}

		const params: Record<string, unknown> = { mode };
		if (mode === 'semantic') params.clusters = parseInteger(opts.clusters, 'clusters', { min: 2, max: 64 });
		if (mode === 'connected') params.min_faces = parseInteger(opts.minFaces, 'min-faces', { min: 1 });
		if (mode === 'plane') {
			params.cap = opts.cap !== false;
			const hasAxis = opts.axis !== undefined;
			const hasOrigin = opts.origin !== undefined;
			if (hasAxis && hasOrigin) {
				throw new MeshifyError(EXIT_PARAM_CONFLICT, '--axis/--position and --origin/--normal are two mutually exclusive plane definitions; pick one');
			}
			if (!hasAxis && !hasOrigin) {
				throw new MeshifyError(EXIT_PARAM_CONFLICT, 'plane mode needs --axis x|y|z + --position, or --origin "x,y,z" + --normal "x,y,z"');
			}
			if (hasOrigin !== (opts.normal !== undefined)) {
				throw new MeshifyError(EXIT_PARAM_CONFLICT, '--origin and --normal must be provided together');
			}
			if (hasAxis) {
				const axis = String(opts.axis).toLowerCase();
				if (axis !== 'x' && axis !== 'y' && axis !== 'z') {
					throw new MeshifyError(EXIT_PARAM_CONFLICT, `--axis only accepts x | y | z, got: ${opts.axis}`);
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

		progress('Loading input…');
		const loaded = await loadInput(input, format);
		assertResourceLimits(loaded.bytes, loaded.inputInfo.faces, { force: !!opts.force });
		assertProcessableGeometry(loaded.inputInfo, 'segment');
		// 预览 before 快照需在内核改动 Document 之前捕获
		const beforeBytes = opts.previewHtml ? await documentToGlbBytes(loaded.doc) : null;

		progress('Building global geometry…');
		const soup = buildSoup(collectPrimitives(loaded.doc));

		let outDoc: Document;
		let partSummaries: { index: number; path: string; vertices: number; faces: number }[];
		let warnings = [...loaded.warnings, ...route.warnings];
		let tierNote: string | undefined;

		if (mode === 'connected') {
			progress('Segmenting connected components…');
			const result = segmentConnected(soup, { minFaces: params.min_faces as number });
			warnings = warnings.concat(result.warnings);
			outDoc = buildPartDocument(loaded.doc, soup, result.parts, { doubleSided: true }); // 坑 3
			partSummaries = collectPartStats(outDoc, result.parts.length);
			tierNote = `connected: ${result.totalComponents} components, ${result.parts.length} parts output`;
			progressDone(`Connected segmentation done: ${result.totalComponents} components → ${result.parts.length} parts`);
		} else if (mode === 'semantic') {
			progress('Segmenting by semantic clustering…');
			const result = segmentSemantic(soup, { clusters: params.clusters as number });
			warnings = warnings.concat(result.warnings);
			outDoc = buildPartDocument(loaded.doc, soup, result.parts, { doubleSided: true });
			applyPartColors(outDoc, result.partColors);
			partSummaries = collectPartStats(outDoc, result.parts.length);
			tierNote = `semantic: ${result.totalComponents} solids, k=${params.clusters}, ${result.parts.length} parts output (clusters by orientation+position, not part semantics)`;
			progressDone(`Semantic segmentation done: ${result.parts.length} parts`);
		} else {
			progress('Cutting by plane…');
			const plane = resolvePlane(soup, params);
			let cut: PlaneCutResult;
			try {
				cut = cutSoupByPlane(soup, plane, { cap: params.cap as boolean });
			} catch (err) {
				throw new MeshifyError(
					EXIT_ALGORITHM_FAILED,
					`Plane cut failed: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
			warnings = warnings.concat(cut.warnings);
			outDoc = buildPlanePartsDocument(loaded.doc, soup, cut, { doubleSided: true });
			partSummaries = collectPartStats(outDoc, cut.parts.length);
			tierNote = `plane: ${cut.parts.length} parts, capped=${cut.capped} (section normals use ±n of the plane; watertightness welded by geometric position)`;
			progressDone(`Plane cut done: ${cut.parts.length} parts (cap ${cut.capped ? 'generated' : 'not generated'})`);
		}

		const om = new OutputManager(input, { overwrite: !!opts.overwrite, explicit: opts.output });
		const outPath = om.claim(om.file(op, 'glb'));
		om.ensureDirFor(outPath);
		await writeDocument(outDoc, outPath);
		partSummaries.forEach((p) => (p.path = outPath));

		const stats = await documentStats(outDoc);
		const files = [fileEntryOf(outPath, 'asset')];

		if (opts.previewHtml) {
			progress('Generating preview page…');
			const htmlPath = om.claim(om.previewPath(outPath));
			writePreviewHtml({
				before: [{ label: 'Input', bytes: beforeBytes! }],
				after: [{ label: `${mode} segmentation output`, bytes: readBytes(outPath) }],
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
			progressDone(`Preview page: ${htmlPath}`);
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
	}));
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
	if (!bbox) throw new MeshifyError(EXIT_ALGORITHM_FAILED, 'Model has no geometry; cannot determine the cut plane');
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
	if (!Number.isFinite(n)) throw new MeshifyError(EXIT_PARAM_CONFLICT, `--${name} needs a number, got: ${raw}`);
	if (opts.min !== undefined && n < opts.min) throw new MeshifyError(EXIT_PARAM_CONFLICT, `--${name} must be ≥ ${opts.min}, got: ${n}`);
	if (opts.max !== undefined && n > opts.max) throw new MeshifyError(EXIT_PARAM_CONFLICT, `--${name} must be ≤ ${opts.max}, got: ${n}`);
	return n;
}
