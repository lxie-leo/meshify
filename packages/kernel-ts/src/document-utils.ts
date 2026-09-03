import { Document, type Material, type Mesh, type Node, type Primitive } from '@gltf-transform/core';
import { copyToDocument, createDefaultPropertyResolver } from '@gltf-transform/functions';
import { createQuietDocument } from './io.js';
import { bboxUnion, computeBBox, type BBox3 } from './geometry/bbox.js';
import { transformDirection, transformPoint } from './geometry/mat4.js';

/**
 * Document 遍历与几何重组工具。
 *
 * 核心抽象：
 * - PrimitiveInfo：单个 primitive 的世界系烘焙几何（segment/texture 分析用）
 *   + 本地系几何（写回用，保留节点变换 → 动画/蒙皮不受破坏）
 * - Soup：全文档三角面汤（跨子网格焊接/切割/聚类用，对齐 maestro _load_solids）
 * - buildPartDocument：从三角子集构建独立 GLB（材质经 copyToDocument 深拷贝，坑 1 天然免疫）
 */

export const MODE_TRIANGLES = 4;

export interface PrimitiveInfo {
	node: Node;
	mesh: Mesh;
	primitive: Primitive;
	/** 展示名（node/mesh 名回退） */
	name: string;
	/** 本地系几何（原样，写回用） */
	localPositions: Float32Array;
	localNormals: Float32Array | null;
	localUvs: Float32Array | null;
	indices: Uint32Array;
	/** 世界系烘焙几何（分析用） */
	worldPositions: Float32Array;
	worldNormals: Float32Array | null;
	material: Material | null;
}

/** 收集全部 TRIANGLES primitive（含世界系烘焙；非三角 mode 跳过）。 */
export function collectPrimitives(doc: Document): PrimitiveInfo[] {
	const out: PrimitiveInfo[] = [];
	for (const scene of doc.getRoot().listScenes()) {
		for (const node of scene.listChildren()) walk(node, doc, out);
	}
	return out;
}

function walk(node: Node, doc: Document, out: PrimitiveInfo[]): void {
	const world = node.getWorldMatrix();
	const mesh = node.getMesh();
	if (mesh) {
		const nodeName = node.getName() || mesh.getName() || 'mesh';
		for (const prim of mesh.listPrimitives()) {
			if ((prim.getMode() ?? MODE_TRIANGLES) !== MODE_TRIANGLES) continue;
			const pos = prim.getAttribute('POSITION');
			if (!pos) continue;
			const lp = accessorToFloat32(pos);
			const lnAttr = prim.getAttribute('NORMAL');
			const luAttr = prim.getAttribute('TEXCOORD_0');
			const localNormals = lnAttr ? accessorToFloat32(lnAttr) : null;
			const localUvs = luAttr ? accessorToFloat32(luAttr) : null;
			const idxArr = prim.getIndices();
			const indices = idxArr
				? toUint32(idxArr.getArray())
				: sequentialIndices(lp.length / 3);

			// 世界系烘焙
			const n = lp.length / 3;
			const worldPositions = new Float32Array(n * 3);
			const tmp: number[] = [0, 0, 0];
			for (let i = 0; i < n; i++) {
				transformPoint(world, lp[i * 3], lp[i * 3 + 1], lp[i * 3 + 2], tmp);
				worldPositions[i * 3] = tmp[0];
				worldPositions[i * 3 + 1] = tmp[1];
				worldPositions[i * 3 + 2] = tmp[2];
			}
			let worldNormals: Float32Array | null = null;
			if (localNormals) {
				worldNormals = new Float32Array(n * 3);
				for (let i = 0; i < n; i++) {
					transformDirection(world, localNormals[i * 3], localNormals[i * 3 + 1], localNormals[i * 3 + 2], tmp);
					worldNormals[i * 3] = tmp[0];
					worldNormals[i * 3 + 1] = tmp[1];
					worldNormals[i * 3 + 2] = tmp[2];
					const len = Math.sqrt(tmp[0] ** 2 + tmp[1] ** 2 + tmp[2] ** 2) || 1;
					worldNormals[i * 3] /= len;
					worldNormals[i * 3 + 1] /= len;
					worldNormals[i * 3 + 2] /= len;
				}
			}
			out.push({
				node,
				mesh,
				primitive: prim,
				name: nodeName,
				localPositions: lp,
				localNormals,
				localUvs,
				indices,
				worldPositions,
				worldNormals,
				material: prim.getMaterial(),
			});
		}
	}
	for (const child of node.listChildren()) walk(child, doc, out);
}

/** 全局三角面汤。 */
export interface Soup {
	prims: PrimitiveInfo[];
	positions: Float32Array;
	normals: Float32Array | null;
	uvs: Float32Array | null;
	indices: Uint32Array;
	/** 每张面的源 primitive 下标 */
	triPrim: Uint32Array;
	/** 每个顶点的源 primitive 下标 */
	vertexPrim: Uint32Array;
	totalTriangles: number;
}

export function buildSoup(prims: PrimitiveInfo[]): Soup {
	let totalVerts = 0;
	let totalTris = 0;
	for (const p of prims) {
		totalVerts += p.localPositions.length / 3;
		totalTris += p.indices.length / 3;
	}
	const positions = new Float32Array(totalVerts * 3);
	const normals = prims.every((p) => p.worldNormals) ? new Float32Array(totalVerts * 3) : null;
	const uvs = prims.every((p) => p.localUvs) ? new Float32Array(totalVerts * 2) : null;
	const indices = new Uint32Array(totalTris * 3);
	const triPrim = new Uint32Array(totalTris);
	const vertexPrim = new Uint32Array(totalVerts);

	let vo = 0;
	let to = 0;
	for (let pi = 0; pi < prims.length; pi++) {
		const p = prims[pi];
		const vn = p.localPositions.length / 3;
		positions.set(p.worldPositions, vo * 3);
		if (normals && p.worldNormals) normals.set(p.worldNormals, vo * 3);
		if (uvs && p.localUvs) uvs.set(p.localUvs, vo * 2);
		vertexPrim.fill(pi, vo, vo + vn);
		for (let t = 0; t < p.indices.length; t++) {
			indices[to * 3 + t] = p.indices[t] + vo;
		}
		const tn = p.indices.length / 3;
		triPrim.fill(pi, to, to + tn);
		vo += vn;
		to += tn;
	}
	return { prims, positions, normals, uvs, indices, triPrim, vertexPrim, totalTriangles: totalTris };
}

/** 将局部几何数组写回 primitive（创建访问器，附着到首个 buffer）。 */
export function setPrimitiveGeometry(
	doc: Document,
	prim: Primitive,
	geo: { positions: Float32Array; normals?: Float32Array | null; uvs?: Float32Array | null; indices?: Uint32Array | null },
): void {
	const buffer = doc.getRoot().listBuffers()[0] ?? doc.createBuffer('meshify');
	prim.setAttribute(
		'POSITION',
		doc.createAccessor().setType('VEC3').setArray(geo.positions).setBuffer(buffer),
	);
	if (geo.normals && geo.normals.length === (geo.positions.length / 3) * 3) {
		prim.setAttribute(
			'NORMAL',
			doc.createAccessor().setType('VEC3').setArray(geo.normals).setBuffer(buffer),
		);
	}
	if (geo.uvs && geo.uvs.length === (geo.positions.length / 3) * 2) {
		prim.setAttribute(
			'TEXCOORD_0',
			doc.createAccessor().setType('VEC2').setArray(geo.uvs).setBuffer(buffer),
		);
	}
	if (geo.indices) {
		prim.setIndices(doc.createAccessor().setType('SCALAR').setArray(geo.indices).setBuffer(buffer));
	}
}

/**
 * 从 soup 中抽取属于某 primitive 的三角子集，压缩顶点后写回 primitive。
 * keptTriangles 为全局三角下标数组（soup.triPrim 筛选）。返回压缩后统计。
 */
export function applyTriangleSubset(
	doc: Document,
	info: PrimitiveInfo,
	soup: Soup,
	keptTriangles: number[],
): { vertices: number; faces: number } {
	const remap = new Map<number, number>();
	const used: number[] = [];
	const newIndices = new Uint32Array(keptTriangles.length * 3);
	for (let t = 0; t < keptTriangles.length; t++) {
		const gt = keptTriangles[t];
		for (let k = 0; k < 3; k++) {
			const gv = soup.indices[gt * 3 + k];
			let lv = remap.get(gv);
			if (lv === undefined) {
				lv = used.length;
				remap.set(gv, lv);
				used.push(gv);
			}
			newIndices[t * 3 + k] = lv;
		}
	}
	const positions = new Float32Array(used.length * 3);
	const normals = soup.normals ? new Float32Array(used.length * 3) : null;
	const uvs = soup.uvs ? new Float32Array(used.length * 2) : null;
	for (let i = 0; i < used.length; i++) {
		const gv = used[i];
		positions[i * 3] = soup.positions[gv * 3];
		positions[i * 3 + 1] = soup.positions[gv * 3 + 1];
		positions[i * 3 + 2] = soup.positions[gv * 3 + 2];
		if (normals) {
			normals[i * 3] = soup.normals![gv * 3];
			normals[i * 3 + 1] = soup.normals![gv * 3 + 1];
			normals[i * 3 + 2] = soup.normals![gv * 3 + 2];
		}
		if (uvs) {
			uvs[i * 2] = soup.uvs![gv * 2];
			uvs[i * 2 + 1] = soup.uvs![gv * 2 + 1];
		}
	}
	// 法线缺失时不伪造（共享顶点会被覆盖成乱法线）：glTF 2.0 规范规定
	// 缺省 NORMAL 时客户端必须自行计算平面法线，省略即正确
	setPrimitiveGeometry(doc, info.primitive, {
		positions,
		normals,
		uvs,
		indices: newIndices,
	});
	return { vertices: used.length, faces: keptTriangles.length };
}

/** 部件几何：一个输出部件 = 若干（源 primitive 分组的）三角子集。 */
export interface PartGeometry {
	name: string;
	/** 每 primitive 一组（保持材质隔离，坑 1） */
	groups: { primIndex: number; triangles: number[] }[];
}

/** 深拷贝材质集合到目标文档（纹理/sampler/扩展一并；绝不共享引用，坑 1）。空集合返回空 Map。 */
export function copyMaterials(
	target: Document,
	sourceDoc: Document,
	materials: Iterable<Material>,
): Map<Material, Material> {
	const list = [...materials];
	if (list.length === 0) return new Map();
	const resolver = createDefaultPropertyResolver(target, sourceDoc);
	const map = copyToDocument(target, sourceDoc, list, resolver);
	return map as unknown as Map<Material, Material>;
}

/**
 * 从源 Document + soup 构建部件输出 Document（独立 GLB）。
 * 材质经 copyToDocument 深拷贝（纹理/sampler 一并），绝不混引用。
 */
export function buildPartDocument(
	sourceDoc: Document,
	soup: Soup,
	parts: PartGeometry[],
	opts: { doubleSided?: boolean } = {},
): Document {
	const target = createQuietDocument();

	// 收集需要的材质并拷贝
	const neededMaterials = new Set<Material>();
	for (const part of parts) {
		for (const g of part.groups) {
			const mat = soup.prims[g.primIndex].material;
			if (mat) neededMaterials.add(mat);
		}
	}
	const matMap = copyMaterials(target, sourceDoc, neededMaterials);

	const scene = target.createScene('part');
	const buffer = target.createBuffer('meshify');

	for (const part of parts) {
		const node = target.createNode(part.name);
		const mesh = target.createMesh(part.name);
		node.setMesh(mesh);
		scene.addChild(node);
		for (const g of part.groups) {
			if (g.triangles.length === 0) continue;
			const info = soup.prims[g.primIndex];
			const remap = new Map<number, number>();
			const used: number[] = [];
			const indices = new Uint32Array(g.triangles.length * 3);
			for (let t = 0; t < g.triangles.length; t++) {
				const gt = g.triangles[t];
				for (let k = 0; k < 3; k++) {
					const gv = soup.indices[gt * 3 + k];
					let lv = remap.get(gv);
					if (lv === undefined) {
						lv = used.length;
						remap.set(gv, lv);
						used.push(gv);
					}
					indices[t * 3 + k] = lv;
				}
			}
			const positions = new Float32Array(used.length * 3);
			const uvs = soup.uvs ? new Float32Array(used.length * 2) : null;
			for (let i = 0; i < used.length; i++) {
				const gv = used[i];
				positions[i * 3] = soup.positions[gv * 3];
				positions[i * 3 + 1] = soup.positions[gv * 3 + 1];
				positions[i * 3 + 2] = soup.positions[gv * 3 + 2];
				if (uvs) {
					uvs[i * 2] = soup.uvs![gv * 2];
					uvs[i * 2 + 1] = soup.uvs![gv * 2 + 1];
				}
			}
			const prim = target.createPrimitive();
			prim.setAttribute(
				'POSITION',
				target.createAccessor().setType('VEC3').setArray(positions).setBuffer(buffer),
			);
			if (uvs) {
				prim.setAttribute(
					'TEXCOORD_0',
					target.createAccessor().setType('VEC2').setArray(uvs).setBuffer(buffer),
				);
			}
			prim.setIndices(target.createAccessor().setType('SCALAR').setArray(indices).setBuffer(buffer));
			const srcMat = info.material;
			if (srcMat) {
				let dstMat = matMap.get(srcMat) as Material | undefined;
				if (dstMat && opts.doubleSided) dstMat.setDoubleSided(true);
				prim.setMaterial(dstMat ?? null);
			}
			mesh.addPrimitive(prim);
		}
	}
	return target;
}

/** 全文档世界系包围盒。 */
export function documentWorldBBox(prims: PrimitiveInfo[]): BBox3 | null {
	let bbox: BBox3 | null = null;
	for (const p of prims) bbox = bboxUnion(bbox, computeBBox(p.worldPositions));
	return bbox;
}

/** 统计面数（全部 TRIANGLES primitive）。 */
export function totalFaces(prims: PrimitiveInfo[]): number {
	let n = 0;
	for (const p of prims) n += p.indices.length / 3;
	return n;
}

function toFloat32(arr: ArrayLike<number>): Float32Array {
	if (arr instanceof Float32Array) return arr;
	const out = new Float32Array(arr.length);
	for (let i = 0; i < arr.length; i++) out[i] = arr[i];
	return out;
}

/** 读取访问器数组为 Float32（KHR_mesh_quantization 归一化整数数组自动反归一化）。 */
function accessorToFloat32(acc: { getArray(): ArrayLike<number> | null; getNormalized(): boolean }): Float32Array {
	const arr = acc.getArray();
	if (!arr) return new Float32Array(0);
	if (!acc.getNormalized()) return toFloat32(arr);
	// glTF normalized attributes: int → max/(2^(b-1)-1)，uint → max/(2^b-1)
	let scale = 1;
	if (arr instanceof Int8Array) scale = 1 / 127;
	else if (arr instanceof Uint8Array) scale = 1 / 255;
	else if (arr instanceof Int16Array) scale = 1 / 32767;
	else if (arr instanceof Uint16Array) scale = 1 / 65535;
	const out = new Float32Array(arr.length);
	for (let i = 0; i < arr.length; i++) out[i] = arr[i] * scale;
	return out;
}

function toUint32(arr: ArrayLike<number>): Uint32Array {
	if (arr instanceof Uint32Array) return arr;
	const out = new Uint32Array(arr.length);
	for (let i = 0; i < arr.length; i++) out[i] = arr[i];
	return out;
}

function sequentialIndices(n: number): Uint32Array {
	const out = new Uint32Array(n);
	for (let i = 0; i < n; i++) out[i] = i;
	return out;
}
