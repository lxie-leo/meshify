import type { Document, Primitive } from '@gltf-transform/core';
import { compactPrimitive, joinPrimitives, weldPrimitive } from '@gltf-transform/functions';
import { warn, type ReportWarning } from '@meshify/core';
import { MeshoptSimplifier } from 'meshoptimizer';
import { collectPrimitives, type PrimitiveInfo } from './document-utils.js';

/**
 * Tier0 QEM 减面（meshopt_simplify，C++ → WASM）。
 *
 * maestro 坑资产内置：
 * - 坑 1：gltf-transform 操作 glTF 场景图本身，材质结构性不丢（此坑在 TS 路线天然不存在）
 * - 坑 12：面数 < min-faces（默认 200）的子网格跳过 + SMALL_MESH_SKIPPED 警告
 * - 坑 2 相关：带贴图子网格简化后提示 UV_REMAP_APPROXIMATED（顶点子集采样，极端形变区可能拉伸）
 * - 语义对齐 pyfqmr：ratio 为「保留面比例」，target_faces 优先；preserve_border ↔ lockBorder
 *
 * 误差上限策略：meshopt 受 error 约束可能提前停止（达不到目标面数），
 * 为对齐 maestro「QEM 总能命中目标面数」的语义，error 从给定值起按 10 倍逐级放宽至 1.0，
 * 最终实际误差如实记入 manifest（max_error_normalized）。
 */

export interface SimplifyKernelOptions {
	ratio?: number;
	targetFaces?: number;
	error?: number;
	keepBorder?: boolean;
	perMesh?: boolean;
	minFaces?: number;
	aggressiveness?: number; // Tier1 (pyfqmr) 语义参数；Tier0 仅回显不使用
}

export interface SimplifyKernelResult {
	facesBefore: number;
	facesAfter: number;
	maxErrorNormalized: number;
	warnings: ReportWarning[];
	errors: string[];
	partial: boolean;
	perMesh: { name: string; before: number; after: number }[];
}

const MIN_FACES_DEFAULT = 200;

export async function simplifyDocument(
	doc: Document,
	opts: SimplifyKernelOptions & { warnings?: ReportWarning[] } = {},
): Promise<SimplifyKernelResult> {
	await MeshoptSimplifier.ready;
	const warnings = opts.warnings ?? [];
	const errors: string[] = [];
	const minFaces = opts.minFaces ?? MIN_FACES_DEFAULT;
	const keepBorder = opts.keepBorder ?? true;
	const baseError = Math.min(Math.max(opts.error ?? 0.01, 1e-6), 1);
	const flags: string[] = keepBorder ? ['LockBorder'] : [];

	let infos = collectPrimitives(doc);
	const facesBefore = totalFaces(infos);

	// --merge：按材质合并同类子网格后统一处理（保持材质不丢，坑 1）
	if (opts.perMesh === false) {
		mergeByMaterial(doc, infos, warnings);
		infos = collectPrimitives(doc);
	}

	// target_faces 按面数比例分摊到各子网格
	const globalRatio = opts.targetFaces
		? Math.min(Math.max(opts.targetFaces / Math.max(facesBefore, 1), 0), 1)
		: (opts.ratio ?? 1);

	const perMesh: { name: string; before: number; after: number }[] = [];
	let facesAfter = 0;
	let maxError = 0;
	let partial = false;

	for (const info of infos) {
		const before = info.indices.length / 3;
		perMesh.push({ name: info.name, before, after: before });

		// 坑 12：小网格跳过
		if (before < minFaces) {
			warnings.push(
				warn('SMALL_MESH_SKIPPED', `${info.name}: ${before} < min-faces ${minFaces}，已跳过简化原样保留`, info.name),
			);
			facesAfter += before;
			continue;
		}
		const target = Math.max(1, Math.floor(before * globalRatio));
		if (target >= before) {
			facesAfter += before;
			continue;
		}

		try {
			const outcome = await simplifyPrimitiveFaces(doc, info, target, baseError, flags);
			if (outcome.facesAfter > 0 && outcome.facesAfter < before) {
				perMesh[perMesh.length - 1].after = outcome.facesAfter;
				facesAfter += outcome.facesAfter;
				maxError = Math.max(maxError, outcome.error);
				if (info.localUvs && info.material?.getBaseColorTexture()) {
					warnings.push(
						warn(
							'UV_REMAP_APPROXIMATED',
							`${info.name}: 贴图网格经简化，纹理在塌缩区域按子集顶点采样，极端形变区可能轻微拉伸`,
							info.name,
						),
					);
				}
			} else {
				// 简化未生效（拓扑受限），保留原样
				facesAfter += before;
			}
		} catch (err) {
			partial = true;
			errors.push(`${info.name}: 简化失败（${err instanceof Error ? err.message : String(err)}），已保留原样`);
			facesAfter += before;
		}
	}

	if (partial) {
		warnings.push(warn('PARTIAL_SUCCESS', '部分子网格简化失败已保留原样，详见 errors'));
	}

	return {
		facesBefore,
		facesAfter,
		maxErrorNormalized: maxError,
		warnings,
		errors,
		partial,
		perMesh,
	};
}

/** 对单个 primitive 以「目标面数」驱动简化（error 逐级放宽直至达标或到 1.0）。 */
async function simplifyPrimitiveFaces(
	doc: Document,
	info: PrimitiveInfo,
	targetFaces: number,
	baseError: number,
	flags: string[],
): Promise<{ facesAfter: number; error: number }> {
	// 位同一焊接（bitwise identical merge）：UV 接缝顶点（同位不同 UV）不会被误并
	try {
		weldPrimitive(info.primitive);
	} catch {
		// 无属性/极端情况下焊接失败不致命，直接按原索引简化
	}

	const prim = info.primitive;
	const posArr = readPositions(prim);
	const indicesIn = readIndices(prim, posArr.length / 3);
	const targetIndices = Math.max(3, targetFaces * 3);

	let best: { indices: Uint32Array; error: number } | null = null;
	for (let err = baseError; ; err = Math.min(err * 10, 1)) {
		const res = callSimplify(indicesIn, posArr, targetIndices, err, flags);
		if (res) {
			best = res;
			if (res.indices.length <= targetIndices * 1.02 || err >= 1) break;
		} else {
			break;
		}
		if (err >= 1) break;
	}
	if (!best || best.indices.length >= indicesIn.length) {
		return { facesAfter: 0, error: 0 };
	}

	const acc = doc
		.createAccessor()
		.setType('SCALAR')
		.setArray(best.indices);
	const buffer = prim.getIndices()?.getBuffer();
	if (buffer) acc.setBuffer(buffer);
	prim.setIndices(acc);
	compactPrimitive(prim);
	return { facesAfter: best.indices.length / 3, error: best.error };
}

/** 兼容 meshoptimizer 0.22（返回 [indices, error] 元组）与 0.23+（返回对象）两种 API。 */
function callSimplify(
	indices: Uint32Array,
	positions: Float32Array,
	targetCount: number,
	targetError: number,
	flags: string[],
): { indices: Uint32Array; error: number } | null {
	try {
		const res = MeshoptSimplifier.simplify(
			indices,
			positions,
			3,
			targetCount,
			targetError,
			flags as never,
		) as unknown;
		if (Array.isArray(res)) {
			const [idx, err] = res as [Uint32Array, number];
			return { indices: idx, error: err };
		}
		const r = res as { indices: Uint32Array; error: number };
		if (r && r.indices) return { indices: r.indices, error: r.error };
		return null;
	} catch {
		return null;
	}
}

/** 按材质合并同类子网格（--merge 模式）：同材质 primitive 合并为单网格，材质不丢。 */
function mergeByMaterial(doc: Document, infos: PrimitiveInfo[], warnings: ReportWarning[]): void {
	const groups = new Map<PrimitiveInfo['material'], PrimitiveInfo[]>();
	for (const info of infos) {
		const list = groups.get(info.material) ?? [];
		list.push(info);
		groups.set(info.material, list);
	}
	const scene = doc.getRoot().listScenes()[0];
	if (!scene) return;
	let mergedAny = false;
	for (const [, list] of groups) {
		if (list.length < 2) continue;
		try {
			const joined = joinPrimitives(list.map((i) => i.primitive));
			const node = doc.createNode(list[0].name + '_merged');
			const mesh = doc.createMesh(list[0].name + '_merged');
			mesh.addPrimitive(joined);
			node.setMesh(mesh);
			if (list[0].material) joined.setMaterial(list[0].material);
			scene.addChild(node);
			// 移除旧 primitive；mesh 清空后从节点摘除并销毁
			for (const info of list) {
				info.mesh.removePrimitive(info.primitive);
				if (info.mesh.listPrimitives().length === 0) {
					info.node.setMesh(null);
					info.mesh.dispose();
				}
			}
			mergedAny = true;
		} catch {
			// 合并失败（属性不兼容等）：保留逐子网格处理
		}
	}
	if (mergedAny) {
		warnings.push(warn('MATERIALS_MERGED', '--merge 模式：同材质子网格已合并处理（材质保持不丢）'));
	}
}

function totalFaces(infos: PrimitiveInfo[]): number {
	let n = 0;
	for (const p of infos) n += p.indices.length / 3;
	return n;
}

function readPositions(prim: Primitive): Float32Array {
	const acc = prim.getAttribute('POSITION');
	const arr = acc?.getArray();
	if (!arr) return new Float32Array(0);
	if (arr instanceof Float32Array) return arr;
	const out = new Float32Array(arr.length);
	for (let i = 0; i < arr.length; i++) out[i] = arr[i];
	return out;
}

function readIndices(prim: Primitive, vertexCount: number): Uint32Array {
	const acc = prim.getIndices();
	const arr = acc?.getArray();
	if (!arr) {
		const out = new Uint32Array(vertexCount);
		for (let i = 0; i < vertexCount; i++) out[i] = i;
		return out;
	}
	if (arr instanceof Uint32Array) return arr;
	const out = new Uint32Array(arr.length);
	for (let i = 0; i < arr.length; i++) out[i] = arr[i];
	return out;
}
