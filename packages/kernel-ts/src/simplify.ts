import type { Document, Primitive } from '@gltf-transform/core';
import { compactPrimitive, joinPrimitives, weldPrimitive } from '@gltf-transform/functions';
import { warn, type ReportWarning } from '@meshify/core';
import { MeshoptSimplifier } from 'meshoptimizer';
import { collectPrimitives, type PrimitiveInfo } from './document-utils.js';

/**
 * Tier0 QEM 减面（meshopt_simplify，C++ → WASM）。
 *
 * 防坑设计（默认行为兜底，同时写警告码告知用户）：
 * - 坑 1：gltf-transform 直接操作 glTF 场景图，材质天然不会丢（TS 路线没有这个坑）
 * - 坑 12：面数小于 min-faces（默认 200）的子网格跳过不减，写 SMALL_MESH_SKIPPED
 * - 坑 2 相关：带贴图的子网格减面后写 UV_REMAP_APPROXIMATED（UV 按顶点子集
 *   近似搬移，剧烈变形的区域可能拉伸）
 * - 语义和 pyfqmr 一致：ratio 是「保留的面数比例」，target_faces 优先；
 *   preserve_border 对应 lockBorder
 *
 * 误差上限策略：meshopt 会受 error 约束提前停下来，面数减不到位。为了
 * 「要求减到多少面就减到多少面」，error 从给定值起每次放宽 10 倍，直到
 * 1.0；实际产生的误差如实写进 manifest（max_error_normalized）。
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
	// UV 接缝造成的面数下限：带 UV 子网格请求目标未达成（实际面数 > 目标 × 1.2）的名单。
	// 机理：UV 岛接缝处同位顶点被切开（位同一焊接不并合），meshopt 视其为锁定边界，
	// 无法跨接缝坍缩 → 深度减面存在结构性下限，--no-keep-border/--merge 均绕不开。
	const uvLimited: string[] = [];

	for (const info of infos) {
		const before = info.indices.length / 3;
		perMesh.push({ name: info.name, before, after: before });

		// 坑 12：小网格跳过
		if (before < minFaces) {
			warnings.push(
				warn('SMALL_MESH_SKIPPED', `${info.name}: ${before} < min-faces ${minFaces}, skipped and kept as-is`, info.name),
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
							`${info.name}: textured mesh simplified; textures sample from the retained vertex subset in collapsed regions, so heavily deformed areas may stretch slightly`,
							info.name,
						),
					);
				}
			} else {
				// 简化未生效（拓扑受限），保留原样
				facesAfter += before;
			}
			// 无论部分达成还是完全未动，只要带 UV 且远超请求目标即记入接缝下限名单
			if (info.localUvs && perMesh[perMesh.length - 1].after > Math.max(1, Math.floor(target * 1.2))) {
				uvLimited.push(info.name);
			}
		} catch (err) {
			partial = true;
			errors.push(`${info.name}: simplification failed (${err instanceof Error ? err.message : String(err)}); kept as-is`);
			facesAfter += before;
		}
	}

	if (uvLimited.length > 0) {
		warnings.push(
			warn(
				'UV_SEAM_DECIMATION_LIMITED',
				`decimation stopped above the requested target on UV-bearing submesh(es) ${uvLimited.join(', ')}: UV island seams act as locked borders that block further collapse (structural floor, not an error-bound stop); simplify before texturing to reach lower face counts`,
			),
		);
	}

	if (partial) {
		warnings.push(warn('PARTIAL_SUCCESS', 'Some submeshes failed to simplify and were kept as-is; see errors'));
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
	const oldAcc = prim.getIndices();
	prim.setIndices(acc);
	// 换索引后旧 accessor 若已无使用者（listParents 仅剩根）须立即回收，
	// 否则序列化出僵尸索引（实测 5120 面模型减面后产物仍带 15360 索引死数据）。
	// 共享 accessor 不能回收：dispose 是全文档摘除，会连坐其他 primitive
	if (oldAcc && oldAcc.listParents().length <= 1) oldAcc.dispose();
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
	let fallbackGroups = 0;
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
			fallbackGroups += 1;
		}
	}
	if (mergedAny) {
		warnings.push(warn('MATERIALS_MERGED', '--merge mode: same-material submeshes merged and processed together (materials kept)'));
	}
	if (fallbackGroups > 0) {
		warnings.push(
			warn(
				'MERGE_INCOMPATIBLE_FALLBACK',
				`--merge: ${fallbackGroups} group(s) of same-material submeshes could not merge due to incompatible vertex attributes; fell back to per-submesh processing (geometry and materials unaffected)`,
			),
		);
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
