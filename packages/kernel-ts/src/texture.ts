import type { Document } from '@gltf-transform/core';
import { warn, type ReportWarning } from '@meshify/core';
import { collectPrimitives, setPrimitiveGeometry, type PrimitiveInfo } from './document-utils.js';

/**
 * UV 投影重生成（Tier0）：五种模式，逐面求 UV、逐顶点按量化 UV 键分裂焊接。
 *
 * - planar：顶视 XZ 平面投影（v 翻转保证 +Y 视角不镜像）
 * - cylindrical：Y 轴柱面，u = (π - θ)/2π（θ = atan2(x, z)，接缝藏在正后方）；
 *   端盖面（|ny| > 0.95）退化为 XZ 平面圆盘投影，避免极点全部塌缩成一条线
 * - spherical：bbox 球心方向映射，φ 自 Y 轴
 * - box：逐面主法线轴选面（±X/±Y/±Z 三对面），带朝向翻转的规范化投影；
 *   同一顶点在不同朝向面得到不同 UV → 按量化 UV 键分裂复制顶点
 * - uv：保留现有 UV；缺失的子网格自动补盒式投影 + AUTO_BOX_UV_GENERATED
 *
 * 接缝处理（cylindrical/spherical）：三角形内 u 跨度 > 0.5（绕接缝环绕）时，
 * 少数侧 u 平移 ±1（允许出界 [0,1]，配合 REPEAT 采样器正确环绕），
 * 避免贴图在整个纹理域上被拉 smear。
 *
 * 投影在世界系进行（多子网格模型展开一致）；UV 是二维属性，写回本地系几何
 * 不受节点变换影响，动画/蒙皮结构不动。
 */

export type TextureMode = 'planar' | 'cylindrical' | 'spherical' | 'box' | 'uv';

export interface TextureKernelOptions {
	mode: TextureMode;
}

export interface TextureKernelResult {
	warnings: ReportWarning[];
	/** 各子网格处理摘要 */
	meshes: { name: string; mode: TextureMode; vertices: number }[];
}

const UV_QUANT = 1e4;
const CAP_NORMAL_THRESHOLD = 0.95;

export function textureDocument(
	doc: Document,
	opts: TextureKernelOptions & { warnings?: ReportWarning[] } = { mode: 'box' },
): TextureKernelResult {
	const warnings = opts.warnings ?? [];
	const prims = collectPrimitives(doc);
	const meshes: TextureKernelResult['meshes'] = [];

	for (const info of prims) {
		let effectiveMode: TextureMode = opts.mode;
		if (opts.mode === 'uv' && !info.localUvs) {
			// 模式 uv 但子网格缺 UV：自动补盒式投影（坑资产：绝不静默，写警告）
			warnings.push(
				warn('AUTO_BOX_UV_GENERATED', `${info.name}: no UV coordinates; box UV auto-generated`, info.name),
			);
			effectiveMode = 'box';
		}
		if (effectiveMode === 'uv') {
			meshes.push({ name: info.name, mode: 'uv', vertices: info.localPositions.length / 3 });
			continue;
		}
		if (info.material?.getBaseColorTexture()) {
			warnings.push(
				warn(
					'UV_REMAP_APPROXIMATED',
					`${info.name}: submesh with an existing texture was reprojected; the displayed texture region will change`,
					info.name,
				),
			);
		}

		const projected = projectPrimitive(info, effectiveMode);
		applyProjectedUv(doc, info, projected);
		meshes.push({ name: info.name, mode: effectiveMode, vertices: info.localPositions.length / 3 });
	}

	return { warnings, meshes };
}

// ---------------------------------------------------------------------------
// 逐面投影 → 顶点 UV 分裂焊接
// ---------------------------------------------------------------------------

/** 逐面计算的 UV（每面 3 对，与三角形顶点一一对应）。 */
interface FaceUvs {
	flat: number[];
}

function projectPrimitive(info: PrimitiveInfo, mode: Exclude<TextureMode, 'uv'>): FaceUvs {
	const wp = info.worldPositions;
	const vn = info.localPositions.length / 3;
	// 世界系 bbox（投影域）
	let minX = Infinity, minY = Infinity, minZ = Infinity;
	let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
	for (let i = 0; i < vn; i++) {
		minX = Math.min(minX, wp[i * 3]); maxX = Math.max(maxX, wp[i * 3]);
		minY = Math.min(minY, wp[i * 3 + 1]); maxY = Math.max(maxY, wp[i * 3 + 1]);
		minZ = Math.min(minZ, wp[i * 3 + 2]); maxZ = Math.max(maxZ, wp[i * 3 + 2]);
	}
	const extX = Math.max(maxX - minX, 1e-12);
	const extY = Math.max(maxY - minY, 1e-12);
	const extZ = Math.max(maxZ - minZ, 1e-12);
	const cx = (minX + maxX) / 2;
	const cy = (minY + maxY) / 2;
	const cz = (minZ + maxZ) / 2;

	const flat: number[] = [];
	const faceCount = info.indices.length / 3;
	for (let t = 0; t < faceCount; t++) {
		const a = info.indices[t * 3];
		const b = info.indices[t * 3 + 1];
		const c = info.indices[t * 3 + 2];
		// 面法线（世界系）
		const ax = wp[a * 3], ay = wp[a * 3 + 1], az = wp[a * 3 + 2];
		const bx = wp[b * 3], by = wp[b * 3 + 1], bz = wp[b * 3 + 2];
		const cxp = wp[c * 3], cyp = wp[c * 3 + 1], czp = wp[c * 3 + 2];
		const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
		const e2x = cxp - ax, e2y = cyp - ay, e2z = czp - az;
		let nx = e1y * e2z - e1z * e2y;
		let ny = e1z * e2x - e1x * e2z;
		let nz = e1x * e2y - e1y * e2x;
		const nl = Math.hypot(nx, ny, nz);
		if (nl > 1e-12) {
			nx /= nl; ny /= nl; nz /= nl;
		}

		const uvOf = (vi: number): [number, number] => {
			const px = wp[vi * 3];
			const py = wp[vi * 3 + 1];
			const pz = wp[vi * 3 + 2];
			switch (mode) {
				case 'planar':
					// 顶视 XZ：+Y 视角下 v 翻转防镜像
					return [(px - minX) / extX, 1 - (pz - minZ) / extZ];
				case 'cylindrical': {
					if (Math.abs(ny) > CAP_NORMAL_THRESHOLD) {
						// 端盖：XZ 圆盘投影（中心 = bbox 中心，半径 = 对角一半）
						const r = Math.hypot(extX, extZ) / 2;
						return [0.5 + (px - cx) / (2 * r), 0.5 + (pz - cz) / (2 * r)];
					}
					const theta = Math.atan2(px - cx, pz - cz); // [-π, π]
					const u = (Math.PI - theta) / (2 * Math.PI);
					return [u, 1 - (py - minY) / extY];
				}
				case 'spherical': {
					const dx = px - cx;
					const dy = py - cy;
					const dz = pz - cz;
					const len = Math.hypot(dx, dy, dz) || 1;
					const theta = Math.atan2(dz, dx); // [-π, π]
					const phi = Math.asin(Math.max(-1, Math.min(1, dy / len)));
					return [(theta + Math.PI) / (2 * Math.PI), 1 - (phi + Math.PI / 2) / Math.PI];
				}
				case 'box': {
					const absNx = Math.abs(nx), absNy = Math.abs(ny), absNz = Math.abs(nz);
					if (absNy >= absNx && absNy >= absNz) {
						// Y 主法线：XZ 面
						let u = (px - minX) / extX;
						let v = (pz - minZ) / extZ;
						if (ny < 0) v = 1 - v;
						return [u, v];
					}
					if (absNx >= absNz) {
						// X 主法线：ZY 面
						let u = (pz - minZ) / extZ;
						const v = 1 - (py - minY) / extY;
						if (nx > 0) u = 1 - u;
						return [u, v];
					}
					// Z 主法线：XY 面
					let u = (px - minX) / extX;
					const v = 1 - (py - minY) / extY;
					if (nz > 0) u = 1 - u;
					return [u, v];
				}
			}
		};

		let uvs = [uvOf(a), uvOf(b), uvOf(c)];
		// 接缝环绕：u 跨度 > 0.5 时少数侧平移 ±1
		if (mode === 'cylindrical' || mode === 'spherical') {
			uvs = unwrapSeam(uvs);
		}
		for (const [u, v] of uvs) flat.push(u, v);
	}
	return { flat };
}

/** 三角形跨环绕接缝时，把少数侧 u 平移 ±1（配合 REPEAT 采样器正确环绕）。 */
function unwrapSeam(uvs: [number, number][]): [number, number][] {
	const us = uvs.map((p) => p[0]);
	const span = Math.max(...us) - Math.min(...us);
	if (span <= 0.5) return uvs;
	const lowCount = us.filter((u) => u < 0.5).length;
	const shiftLow = lowCount <= us.length - lowCount; // 少数侧是低段则 +1，否则 -1
	return uvs.map(([u, v]) => {
		const isLow = u < 0.5;
		const shift = shiftLow ? (isLow ? 1 : 0) : isLow ? 0 : -1;
		return [u + shift, v] as [number, number];
	});
}

/** 把逐面 UV 写回 primitive：按量化 UV 键分裂复制顶点（box/接缝需要）。 */
function applyProjectedUv(doc: Document, info: PrimitiveInfo, faceUvs: FaceUvs): void {
	const faceCount = info.indices.length / 3;
	const vertCount = info.localPositions.length / 3;

	// 顶点 → UV 槽（量化键）；同顶点多个不同 UV → 复制顶点
	const slotOf = new Map<number, Map<string, number>>();
	const slots: number[] = []; // 槽 → 源顶点
	const slotUv: number[] = []; // 槽 → u,v
	const slotFor = (vertex: number, u: number, v: number): number => {
		const key = `${Math.round(u * UV_QUANT)},${Math.round(v * UV_QUANT)}`;
		let byKey = slotOf.get(vertex);
		if (!byKey) {
			byKey = new Map();
			slotOf.set(vertex, byKey);
		}
		const existing = byKey.get(key);
		if (existing !== undefined) return existing;
		const slot = slots.length;
		slots.push(vertex);
		slotUv.push(u, v);
		byKey.set(key, slot);
		return slot;
	};

	const newIndices = new Uint32Array(faceCount * 3);
	for (let t = 0; t < faceCount; t++) {
		for (let k = 0; k < 3; k++) {
			const v = info.indices[t * 3 + k];
			newIndices[t * 3 + k] = slotFor(v, faceUvs.flat[t * 6 + k * 2], faceUvs.flat[t * 6 + k * 2 + 1]);
		}
	}

	const positions = new Float32Array(slots.length * 3);
	const normals = info.localNormals ? new Float32Array(slots.length * 3) : null;
	const uvs = new Float32Array(slots.length * 2);
	for (let s = 0; s < slots.length; s++) {
		const v = slots[s];
		positions[s * 3] = info.localPositions[v * 3];
		positions[s * 3 + 1] = info.localPositions[v * 3 + 1];
		positions[s * 3 + 2] = info.localPositions[v * 3 + 2];
		if (normals && info.localNormals) {
			normals[s * 3] = info.localNormals[v * 3];
			normals[s * 3 + 1] = info.localNormals[v * 3 + 1];
			normals[s * 3 + 2] = info.localNormals[v * 3 + 2];
		}
		uvs[s * 2] = slotUv[s * 2];
		uvs[s * 2 + 1] = slotUv[s * 2 + 1];
	}
	void vertCount;
	setPrimitiveGeometry(doc, info.primitive, { positions, normals, uvs, indices: newIndices });
}
