import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Command } from 'commander';
import type { Document } from '@gltf-transform/core';
import {
	MeshifyError,
	EXIT_ALGORITHM_FAILED,
	EXIT_INPUT_UNREADABLE,
	EXIT_INTERNAL,
	EXIT_PARAM_CONFLICT,
	type InputInfo,
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
					'STEP 输入必须经 Tier1 (Python/gmsh) 处理，Tier0 加载路径不可达。',
				);
		}
	} catch (err) {
		if (err instanceof MeshifyError) throw err;
		throw new MeshifyError(
			EXIT_INPUT_UNREADABLE,
			`输入解析失败（${path.basename(inputPath)}，格式 ${format}）: ${err instanceof Error ? err.message : String(err)}`,
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
		`输入不含任何三角面，${command} 无可处理几何。可先 inspect 查看文件结构；空场景请检查导出设置。`,
	);
}

function readText(p: string): string {
	try {
		return fs.readFileSync(p, 'utf-8');
	} catch (err) {
		throw new MeshifyError(
			EXIT_INPUT_UNREADABLE,
			`无法读取输入: ${p}（${err instanceof Error ? err.message : String(err)}）`,
		);
	}
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
		throw new MeshifyError(EXIT_PARAM_CONFLICT, `--${name} 需要 "x,y,z" 形式的三个有限数字，收到: ${raw}`);
	}
	return [parts[0], parts[1], parts[2]];
}

// ---------------------------------------------------------------------------
// 报告收尾（实现在 report-out.ts；此处再导出供命令层统一引用）
// ---------------------------------------------------------------------------

export { emitReport, emitExistingReport, fmtCount, fmtBytes } from './report-out.js';

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
		c = c.option('-o, --output <path>', '输出路径（默认 <input>.meshify/<name>.<op>.<ext>）');
	}
	return c
		.option('--report <path>', 'manifest 路径（默认 <input>.meshify/<name>.<op>.report.json，工具自有日志可自动覆盖）')
		.option('--tier <mode>', '内核选择: auto | ts | py（默认 auto；STEP 必须 py）', 'auto')
		.option('--preview-html', '生成 before/after 对比预览页（自包含单文件 HTML）')
		.option('--overwrite', '覆盖已存在的输出产物（输入文件任何情况下不被覆盖）')
		.option('--json', 'stdout 输出完整 manifest JSON（供 Agent 消费）')
		.option('--force', '跳过面数/字节资源上限防护（大模型一次性处理）');
}

/** 解析 --tier（非法值 = exit 4）。 */
export function parseTierPref(raw: unknown): 'auto' | 'ts' | 'py' {
	const v = String(raw ?? 'auto');
	if (v !== 'auto' && v !== 'ts' && v !== 'py') {
		throw new MeshifyError(EXIT_PARAM_CONFLICT, `--tier 只接受 auto | ts | py，收到: ${v}`);
	}
	return v;
}

/** 数值选项解析（非法 = exit 4）。 */
export function parseNumber(raw: unknown, name: string, opts: { min?: number; max?: number } = {}): number {
	const n = Number(raw);
	if (!Number.isFinite(n)) {
		throw new MeshifyError(EXIT_PARAM_CONFLICT, `--${name} 需要数字，收到: ${raw}`);
	}
	if (opts.min !== undefined && n < opts.min) {
		throw new MeshifyError(EXIT_PARAM_CONFLICT, `--${name} 必须 ≥ ${opts.min}，收到: ${n}`);
	}
	if (opts.max !== undefined && n > opts.max) {
		throw new MeshifyError(EXIT_PARAM_CONFLICT, `--${name} 必须 ≤ ${opts.max}，收到: ${n}`);
	}
	return n;
}

export function parseInteger(raw: unknown, name: string, opts: { min?: number; max?: number } = {}): number {
	const n = parseNumber(raw, name, opts);
	if (!Number.isInteger(n)) {
		throw new MeshifyError(EXIT_PARAM_CONFLICT, `--${name} 需要整数，收到: ${raw}`);
	}
	return n;
}
