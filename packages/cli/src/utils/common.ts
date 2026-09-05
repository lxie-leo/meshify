import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Command } from 'commander';
import type { Document } from '@gltf-transform/core';
import {
	MeshifyError,
	warn,
	generateReport,
	EXIT_ALGORITHM_FAILED,
	EXIT_INPUT_UNREADABLE,
	EXIT_INTERNAL,
	EXIT_PARAM_CONFLICT,
	type InputInfo,
	type MeshifyReport,
	type ReportWarning,
} from '@meshify/core';
import {
	createIO,
	inspectDocument,
	objToDocument,
	parseMtl,
	plyToDocument,
	readDocument,
	stlToDocument,
	toInputInfo,
} from '@meshify/kernel-ts';
import type { InputFormat } from './format-detect.js';
import { OutputManager } from './output.js';
import { emitFailureReport } from './report-out.js';

/** commander 全局选项（program.opts() 子集，各命令共用）。 */
export interface GlobalOptions {
	output?: string;
	report?: string;
	tier?: 'auto' | 'ts' | 'py';
	previewHtml?: boolean;
	overwrite?: boolean;
	json?: boolean;
	force?: boolean;
}

// ---------------------------------------------------------------------------
// 输入加载（统一入口：glb/gltf 走 NodeIO，obj/stl/ply 走自研读取器）
// ---------------------------------------------------------------------------

export interface LoadedInput {
	doc: Document;
	format: InputFormat;
	bytes: number;
	inputInfo: InputInfo;
	warnings: ReportWarning[];
}

export async function loadInput(inputPath: string, format: InputFormat): Promise<LoadedInput> {
	const bytes = fs.statSync(inputPath).size;
	const warnings: ReportWarning[] = [];
	let doc: Document;

	// 解析/解码失败 = 输入不可读（exit 2），不是内部错误：
	// 截断 GLB、垃圾 OBJ、空 PLY、引用缺失 .bin 的 .gltf 都归此类（与 Tier1 口径一致）
	try {
		switch (format) {
			case 'glb':
			case 'gltf':
				doc = await readDocument(inputPath);
				break;
			case 'obj': {
				const text = readText(inputPath);
				const { mtl, mtlWarnings } = loadSiblingMtl(inputPath);
				const images = loadMtlImages(mtl, path.dirname(inputPath));
				const obj = objToDocument(text, mtl, images);
				doc = obj.doc;
				warnings.push(...obj.warnings); // 越界索引 / 材质合并等披露不能在加载层丢弃
				warnings.push(...mtlWarnings);
				// 扩展名路由优先：二进制内容冒充 .obj（如 STL 改名）会解析出 0 顶点——
				// 静默空结果对 Agent 是坑，显式披露让上游有机会检查文件真实格式
				if (looksLikeBinaryText(text)) {
					warnings.push(
						warn(
							'FORMAT_CONTENT_MISMATCH',
							`Input ${path.basename(inputPath)} treated as OBJ by extension, but the content is binary (${doc.getRoot().listMeshes().length} submesh(es) parsed); the file may be another format renamed`,
						),
					);
				}
				break;
			}
			case 'stl':
				doc = stlToDocument(new Uint8Array(fs.readFileSync(inputPath)), path.basename(inputPath, '.stl'));
				break;
			case 'ply':
				doc = plyToDocument(new Uint8Array(fs.readFileSync(inputPath)), path.basename(inputPath, '.ply'));
				break;
			case 'step':
				// STEP 只能经 Tier1（convert 命令在 tier 仲裁处已分流，此处不可达）
				throw new MeshifyError(
					EXIT_INTERNAL,
					'STEP input must go through Tier1 (Python/gmsh); the Tier0 load path is unreachable.',
				);
		}
	} catch (err) {
		if (err instanceof MeshifyError) throw err;
		throw new MeshifyError(
			EXIT_INPUT_UNREADABLE,
			`Input parse failed (${path.basename(inputPath)}, format ${format}): ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	const inspected = await inspectDocument(doc);
	return {
		doc,
		format,
		bytes,
		inputInfo: toInputInfo(inputPath, format, bytes, inspected),
		warnings,
	};
}

/**
 * 几何命令（simplify/segment/texture/lod/optimize）前置：
 * 输入 0 面 → exit 6，任何产物写盘前失败（inspect/convert 是结构操作，不拦；
 * 与 Tier1 runner 的集中拦截同口径）。
 */
export function assertProcessableGeometry(inputInfo: InputInfo, command: string): void {
	if (inputInfo.faces > 0) return;
	throw new MeshifyError(
		EXIT_ALGORITHM_FAILED,
		`Input contains no triangles; ${command} has no geometry to process. Run inspect to check the file structure; for empty scenes, review the export settings.`,
	);
}

function readText(p: string): string {
	try {
		return fs.readFileSync(p, 'utf-8');
	} catch (err) {
		throw new MeshifyError(
			EXIT_INPUT_UNREADABLE,
			`Cannot read input: ${p} (${err instanceof Error ? err.message : String(err)})`,
		);
	}
}

/** 文本疑似二进制：头部控制字符（NUL 等）占比过高（OBJ 是纯文本格式）。 */
function looksLikeBinaryText(text: string): boolean {
	const head = text.slice(0, 4096);
	if (!head) return false;
	let suspicious = 0;
	for (const ch of head) {
		const c = ch.charCodeAt(0);
		if (c === 0 || (c < 0x09) || (c > 0x0d && c < 0x20)) suspicious++;
	}
	return suspicious / head.length > 0.02;
}

/** OBJ 伴生 .mtl 探测：<name>.mtl 或 mtllib 声明的文件（同目录）。 */
function loadSiblingMtl(objPath: string): { mtl: ReturnType<typeof parseMtl> | null; mtlWarnings: ReportWarning[] } {
	const dir = path.dirname(objPath);
	const declared: string[] = [];
	try {
		for (const line of fs.readFileSync(objPath, 'utf-8').split(/\r?\n/)) {
			const t = line.trim();
			if (t.startsWith('mtllib ')) declared.push(t.slice(7).trim());
		}
	} catch {
		return { mtl: null, mtlWarnings: [] };
	}
	const candidates = [
		...declared.map((n) => path.resolve(dir, n)),
		path.resolve(dir, path.basename(objPath, '.obj') + '.mtl'),
	];
	for (const mtlPath of candidates) {
		if (fs.existsSync(mtlPath)) {
			return { mtl: parseMtl(readText(mtlPath)), mtlWarnings: [] };
		}
	}
	return { mtl: null, mtlWarnings: [] };
}

/** mtl 引用的贴图（同目录相对路径）。 */
function loadMtlImages(mtl: ReturnType<typeof parseMtl> | null, dir: string): Map<string, Uint8Array> {
	const images = new Map<string, Uint8Array>();
	if (!mtl) return images;
	for (const mat of mtl.values()) {
		if (!mat.mapKd || images.has(mat.mapKd)) continue;
		const p = path.resolve(dir, mat.mapKd);
		try {
			if (fs.existsSync(p)) images.set(mat.mapKd, new Uint8Array(fs.readFileSync(p)));
		} catch {
			// 单张贴图读失败：材质退化为纯色（内核已处理）
		}
	}
	return images;
}

// ---------------------------------------------------------------------------
// 参数解析
// ---------------------------------------------------------------------------

/** "x,y,z" → [x,y,z]（容错空格）；非法即 exit 4。 */
export function parseVec3(raw: string, name: string): [number, number, number] {
	const parts = raw
		.split(',')
		.map((s) => Number(s.trim()));
	if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) {
		throw new MeshifyError(EXIT_PARAM_CONFLICT, `--${name} needs three finite numbers in the form "x,y,z", got: ${raw}`);
	}
	return [parts[0], parts[1], parts[2]];
}

// ---------------------------------------------------------------------------
// 报告收尾（实现在 report-out.ts；此处再导出供命令层统一引用）
// ---------------------------------------------------------------------------

export { emitReport, emitExistingReport, emitFailureReport, fmtCount, fmtBytes } from './report-out.js';

/** 输出 Document 的统一指标采集（面数/顶点数）。 */
export async function documentStats(doc: Document): Promise<{ vertices: number; faces: number }> {
	const inspected = await inspectDocument(doc);
	return { vertices: inspected.vertices, faces: inspected.faces };
}

/** 将 Document 序列化为 GLB 字节（预览页内嵌用；输入为非 glTF 格式时也能预览）。 */
export async function documentToGlbBytes(doc: Document): Promise<Uint8Array> {
	const io = await createIO();
	return io.writeBinary(doc);
}

// ---------------------------------------------------------------------------
// commander 共享选项（逐子命令注册：commander 的根选项需写在子命令名之前，
// 逐命令注册才能支持 `meshify simplify model.glb --json` 的自然顺序）
// ---------------------------------------------------------------------------

export interface CommonCommandFlags {
	/** 不提供 -o（inspect/doctor 等无模型产物的命令） */
	noOutput?: boolean;
}

export function addCommonOptions(cmd: Command, flags: CommonCommandFlags = {}): Command {
	let c = cmd;
	if (!flags.noOutput) {
		c = c.option('-o, --output <path>', 'output path (default <input>.meshify/<name>.<op>.<ext>)');
	}
	return c
		.option('--report <path>', "manifest path (default <input>.meshify/<name>.<op>.report.json; the tool's own logs auto-overwrite)")
		.option('--tier <mode>', 'kernel selection: auto | ts | py (default auto; STEP requires py)', 'auto')
		.option('--preview-html', 'generate a before/after comparison preview page (self-contained single-file HTML)')
		.option('--overwrite', 'overwrite existing output artifacts (the input file is never overwritten)')
		.option('--json', 'write the full manifest JSON to stdout (for agents to consume)')
		.option('--force', 'skip the face-count/byte resource guards (one-shot processing of large models)');
}

/** 解析 --tier（非法值 = exit 4）。 */
export function parseTierPref(raw: unknown): 'auto' | 'ts' | 'py' {
	const v = String(raw ?? 'auto');
	if (v !== 'auto' && v !== 'ts' && v !== 'py') {
		throw new MeshifyError(EXIT_PARAM_CONFLICT, `--tier only accepts auto | ts | py, got: ${v}`);
	}
	return v;
}

// ---------------------------------------------------------------------------
// 失败也产出 manifest（早失败路径的结构化错误披露）
// ---------------------------------------------------------------------------

type ModelCommandAction = (input: string, opts: GlobalOptions & Record<string, unknown>) => Promise<void>;

/**
 * MeshifyError 早失败（输入不可读 / 参数冲突 / Tier1 缺位 / 空场景等）默认不落
 * 任何报告——--json 的 Agent 只能拿退出码。本包装器在 rethrow 前尽力组装最小
 * manifest（输入结构未知 → 0 值兜底 + errors[] 携带原因）写盘，--json 时进 stdout。
 *
 * - Tier1 路径不抛 MeshifyError（kernel 返回后自管 manifest + exitCode），不会双重产出
 * - op 可为函数（convert 的 op 段含目标格式，在失败时也可从 opts 推出）
 * - 报告组装自身的失败静默吞掉：不掩盖原始错误
 */
export function withFailureManifest(
	command: string,
	op: string | ((opts: GlobalOptions & Record<string, unknown>) => string),
	action: ModelCommandAction,
): ModelCommandAction {
	return async (input, opts) => {
		const startedAt = Date.now();
		try {
			await action(input, opts);
		} catch (err) {
			if (err instanceof MeshifyError) {
				try {
					const report = failureReport(command, input, err, Date.now() - startedAt);
					// op 可能从原始 opts 推出（convert 的 --to、segment 的 --mode），
					// 此时值未经验证——净化后才能进报告文件名，防路径逃逸
					const rawOp = typeof op === 'function' ? op(opts) : op;
					const opName = rawOp.replace(/[^a-zA-Z0-9_-]/g, '') || 'unknown';
					const om = new OutputManager(input, { overwrite: true, explicit: opts.output });
					emitFailureReport(report, {
						reportPath: opts.report ?? om.reportPath(opName),
						json: !!opts.json,
					});
				} catch {
					// 报告失败不掩盖原始错误
				}
			}
			throw err;
		}
	};
}

function failureReport(
	command: string,
	input: string,
	err: MeshifyError,
	durationMs: number,
): MeshifyReport {
	let bytes = 0;
	try {
		bytes = fs.statSync(input).size;
	} catch {
		// 文件可能不存在（exit 2 场景）：bytes=0 如实反映
	}
	const inputInfo: InputInfo = {
		path: path.resolve(input),
		format: path.extname(input).slice(1).toLowerCase() || 'unknown',
		bytes,
		vertices: 0,
		faces: 0,
		meshes: [],
		materials: 0,
		textures: [],
		bbox: null,
		has_animation: false,
	};
	return generateReport({
		command,
		input: inputInfo,
		output: null,
		params: { failed_early: true },
		warnings: [],
		errors: [err.message],
		exitCode: err.code,
		durationMs,
	});
}

/** 数值选项解析（非法 = exit 4）。 */
export function parseNumber(raw: unknown, name: string, opts: { min?: number; max?: number } = {}): number {
	const n = Number(raw);
	if (!Number.isFinite(n)) {
		throw new MeshifyError(EXIT_PARAM_CONFLICT, `--${name} needs a number, got: ${raw}`);
	}
	if (opts.min !== undefined && n < opts.min) {
		throw new MeshifyError(EXIT_PARAM_CONFLICT, `--${name} must be ≥ ${opts.min}, got: ${n}`);
	}
	if (opts.max !== undefined && n > opts.max) {
		throw new MeshifyError(EXIT_PARAM_CONFLICT, `--${name} must be ≤ ${opts.max}, got: ${n}`);
	}
	return n;
}

export function parseInteger(raw: unknown, name: string, opts: { min?: number; max?: number } = {}): number {
	const n = parseNumber(raw, name, opts);
	if (!Number.isInteger(n)) {
		throw new MeshifyError(EXIT_PARAM_CONFLICT, `--${name} needs an integer, got: ${raw}`);
	}
	return n;
}
