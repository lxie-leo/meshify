import earcut, { refine as earcutRefine } from 'earcut';
import { Document, type Material } from '@gltf-transform/core';
import { warn, type ReportWarning } from '@meshify/core';
import { copyMaterials, type Soup } from './document-utils.js';
import { weldKey } from './geometry/union-find.js';

/**
 * 平面切割（Tier0）：逐三角形半空间裁剪 + 截面 earcut 三角化封口。
 *
 * maestro 坑资产内置：
 * - 坑 5：不封口则两半是开口壳、3D 打印/布尔运算直接废——截面默认 earcut 封口保水密
 * - 坑 6：封口三角化可能产生零面积碎片三角形，按面积过滤会在壳上开洞——原样保留
 *   （渲染不可见），写 FRAGMENT_FACES_KEPT 警告
 * - 坑 1：输出按源 primitive 分组、材质深拷贝，多材质模型结构不丢
 * - 坑 3：开口/切割产物材质强制 doubleSided（由调用方传 opts.doubleSided）
 *
 * 坐标语义：soup 是世界系烘焙几何，origin/normal 即原生坐标系绝对值；
 * 封口顶点独立复制（不与切割面共享顶点），法线取 ±n 保证截面平直着色。
 * 截面交点按量化位置缓存归一：相邻面共享同一条几何边但顶点不共享
 * （CAD 导出常见）时，两侧/两面的交点仍是同一顶点，切口边线精确贴合。
 */

export interface PlaneSpec {
	origin: [number, number, number];
	normal: [number, number, number];
}

/** 一组显式三角形（扁平全局顶点三元组；id < totalVerts 为原顶点，否则为 extra 顶点）。 */
export interface TriangleGroup {
	primIndex: number;
	tris: number[];
}

export interface PlanePart {
	name: string;
	groups: TriangleGroup[];
	triangleCount: number;
}

export interface PlaneCutResult {
	parts: PlanePart[];
	warnings: ReportWarning[];
	/** 切割新增顶点（截面交点 + 封口复制顶点），追加在原 soup 顶点之后 */
	extra: { positions: number[]; normals: number[] | null; uvs: number[] | null };
	totalVerts: number;
	capped: boolean;
}

interface ExtraPool {
	positions: number[];
	normals: number[] | null;
	uvs: number[] | null;
}

export function cutSoupByPlane(soup: Soup, plane: PlaneSpec, opts: { cap: boolean }): PlaneCutResult {
	const warnings: ReportWarning[] = [];
	const totalVerts = soup.positions.length / 3;

	let [nx, ny, nz] = plane.normal;
	const nlen = Math.hypot(nx, ny, nz);
	if (!(nlen > 0)) throw new Error('切割平面法线为零向量');
	nx /= nlen;
	ny /= nlen;
	nz /= nlen;
	const [ox, oy, oz] = plane.origin;

	// 带符号距离 + 场景尺度（用于 on-plane 容差）
	const d = new Float64Array(totalVerts);
	let maxAbs = 1;
	for (let i = 0; i < totalVerts; i++) {
		const px = soup.positions[i * 3];
		const py = soup.positions[i * 3 + 1];
		const pz = soup.positions[i * 3 + 2];
		maxAbs = Math.max(maxAbs, Math.abs(px), Math.abs(py), Math.abs(pz));
		d[i] = (px - ox) * nx + (py - oy) * ny + (pz - oz) * nz;
	}
	const eps = 1e-9 * maxAbs;
	const onPlane = (v: number): boolean => (v < totalVerts ? Math.abs(d[v]) <= eps : true);

	const extra: ExtraPool = {
		positions: [],
		normals: soup.normals ? [] : null,
		uvs: soup.uvs ? [] : null,
	};
	/** 量化位置 → 截面交点 id 缓存（两侧共享同一交点） */
	const crossing = new Map<string, number>();

	const makeCrossing = (a: number, b: number): number => {
		const lo = Math.min(a, b);
		const hi = Math.max(a, b);

		const da = d[lo];
		const db = d[hi];
		const t = da / (da - db || 1e-30);
		const px = soup.positions[lo * 3] + (soup.positions[hi * 3] - soup.positions[lo * 3]) * t;
		const py = soup.positions[lo * 3 + 1] + (soup.positions[hi * 3 + 1] - soup.positions[lo * 3 + 1]) * t;
		const pz = soup.positions[lo * 3 + 2] + (soup.positions[hi * 3 + 2] - soup.positions[lo * 3 + 2]) * t;
		// 精确吸附到平面：保证 on-plane 判定成立、边界环闭合
		const dd = (px - ox) * nx + (py - oy) * ny + (pz - oz) * nz;
		const qx = px - nx * dd;
		const qy = py - ny * dd;
		const qz = pz - nz * dd;

		const key = weldKey(qx, qy, qz);
		const cached = crossing.get(key);
		if (cached !== undefined) return cached;

		const id = totalVerts + extra.positions.length / 3;
		extra.positions.push(qx, qy, qz);
		if (extra.normals && soup.normals) {
			let mx = soup.normals[lo * 3] + (soup.normals[hi * 3] - soup.normals[lo * 3]) * t;
			let my = soup.normals[lo * 3 + 1] + (soup.normals[hi * 3 + 1] - soup.normals[lo * 3 + 1]) * t;
			let mz = soup.normals[lo * 3 + 2] + (soup.normals[hi * 3 + 2] - soup.normals[lo * 3 + 2]) * t;
			const len = Math.hypot(mx, my, mz);
			if (len > 1e-12) {
				mx /= len;
				my /= len;
				mz /= len;
			}
			extra.normals.push(mx, my, mz);
		}
		if (extra.uvs && soup.uvs) {
			extra.uvs.push(
				soup.uvs[lo * 2] + (soup.uvs[hi * 2] - soup.uvs[lo * 2]) * t,
				soup.uvs[lo * 2 + 1] + (soup.uvs[hi * 2 + 1] - soup.uvs[lo * 2 + 1]) * t,
			);
		}
		crossing.set(key, id);
		return id;
	};

	// ---- 逐侧裁剪（Sutherland–Hodgman 保持原绕向）----
	const groupsA = new Map<number, number[]>();
	const groupsB = new Map<number, number[]>();
	const posKeyOf = new Map<number, string>();
	const posKey = (v: number): string => {
		let k = posKeyOf.get(v);
		if (k === undefined) {
			if (v < totalVerts) {
				k = weldKey(soup.positions[v * 3], soup.positions[v * 3 + 1], soup.positions[v * 3 + 2]);
			} else {
				const i = v - totalVerts;
				k = weldKey(extra.positions[i * 3], extra.positions[i * 3 + 1], extra.positions[i * 3 + 2]);
			}
			posKeyOf.set(v, k);
		}
		return k;
	};
	const clipSide = (positive: boolean, groups: Map<number, number[]>): void => {
		const sd = (v: number): number => (positive ? d[v] : -d[v]);
		for (let t = 0; t < soup.totalTriangles; t++) {
			const tri = [soup.indices[t * 3], soup.indices[t * 3 + 1], soup.indices[t * 3 + 2]];
			const poly: number[] = [];
			for (let e = 0; e < 3; e++) {
				const cur = tri[e];
				const nxt = tri[(e + 1) % 3];
				const sc = sd(cur);
				const sn = sd(nxt);
				if (sc >= 0) poly.push(cur);
				if (sc >= 0 !== sn >= 0) poly.push(makeCrossing(cur, nxt));
			}
			// 去除连续重复点：先按顶点 id，再按量化位置（原顶点恰在平面上时，交点
			// 与原顶点同位但 id 不同，不去重会留下零面积碎片，破坏切口流形性）
			const byId: number[] = [];
			for (const v of poly) {
				if (byId.length === 0 || byId[byId.length - 1] !== v) byId.push(v);
			}
			if (byId.length > 1 && byId[0] === byId[byId.length - 1]) byId.pop();
			const dedup: number[] = [];
			let dedupKeys: string[] = [];
			for (const v of byId) {
				const k = posKey(v);
				if (dedupKeys.length === 0 || dedupKeys[dedupKeys.length - 1] !== k) {
					dedup.push(v);
					dedupKeys.push(k);
				}
			}
			if (dedupKeys.length > 1 && dedupKeys[0] === dedupKeys[dedupKeys.length - 1]) {
				dedup.pop();
				dedupKeys.pop();
			}
			if (dedup.length < 3) continue;
			const list = groups.get(soup.triPrim[t]) ?? [];
			for (let k = 1; k + 1 < dedup.length; k++) {
				list.push(dedup[0], dedup[k], dedup[k + 1]);
			}
			groups.set(soup.triPrim[t], list);
		}
	};
	clipSide(true, groupsA);
	clipSide(false, groupsB);

	if (groupsA.size === 0 && groupsB.size === 0) {
		throw new Error('切割平面未与模型相交（未产生任何三角形）');
	}

	// ---- 封口（坑 5）----
	let capped = false;
	if (opts.cap) {
		const capA = capSide(soup, groupsA, { totalVerts, onPlane, extra, capNormal: [-nx, -ny, -nz], warnings });
		const capB = capSide(soup, groupsB, { totalVerts, onPlane, extra, capNormal: [nx, ny, nz], warnings });
		capped = capA + capB > 0;
		if (capped && soup.uvs) {
			warnings.push(
				warn('UV_REMAP_APPROXIMATED', '截面封口顶点 UV 按切口边插值（近似），贴图在截面处可能轻微拉伸'),
			);
		}
		// 显式披露：截面存在（产生了交点）却未能封口——典型如重合壳/非流形截面
		if (!capped && crossing.size > 0) {
			warnings.push(
				warn(
					'NON_MANIFOLD_INPUT',
					'切割产生了截面交点但未能提取闭合边界环（疑似重合壳/非流形输入），截面未封口',
				),
			);
		}
	}

	const toPart = (groups: Map<number, number[]>, name: string): PlanePart | null => {
		const gs: TriangleGroup[] = [];
		let triangleCount = 0;
		for (const [primIndex, tris] of groups) {
			if (tris.length === 0) continue;
			gs.push({ primIndex, tris });
			triangleCount += tris.length / 3;
		}
		if (triangleCount === 0) return null;
		return { name, groups: gs, triangleCount };
	};
	// part_000 = 法线正侧，part_001 = 负侧；平面相切时可能只剩一侧
	const parts = [toPart(groupsA, 'part_000'), toPart(groupsB, 'part_001')].filter(
		(p): p is PlanePart => p !== null,
	);

	return { parts, warnings, extra, totalVerts, capped };
}

// ---------------------------------------------------------------------------
// 截面封口
// ---------------------------------------------------------------------------

interface CapContext {
	totalVerts: number;
	onPlane: (v: number) => boolean;
	extra: ExtraPool;
	capNormal: [number, number, number];
	warnings: ReportWarning[];
}

/** 对一侧三角集合提取截面边界环并三角化封口；返回新增封口三角形数。 */
function capSide(soup: Soup, groups: Map<number, number[]>, ctx: CapContext): number {
	const { totalVerts, onPlane, extra, capNormal, warnings } = ctx;

	// 1. 平面上双边统计 → 边界边（出现次数 = 1）
	const flat: number[] = [];
	for (const tris of groups.values()) flat.push(...tris);
	const edgeCount = new Map<string, number>();
	const edgeVerts = new Map<string, [number, number]>();
	for (let t = 0; t < flat.length / 3; t++) {
		for (let k = 0; k < 3; k++) {
			const a = flat[t * 3 + k];
			const b = flat[t * 3 + (k + 1) % 3];
			if (!onPlane(a) || !onPlane(b) || a === b) continue;
			const key = `${Math.min(a, b)}_${Math.max(a, b)}`;
			edgeCount.set(key, (edgeCount.get(key) ?? 0) + 1);
			edgeVerts.set(key, [a, b]);
		}
	}
	const boundary: string[] = [];
	for (const [key, count] of edgeCount) if (count === 1) boundary.push(key);
	if (boundary.length === 0) return 0;

	const posAt = (v: number): [number, number, number] => {
		if (v < totalVerts) {
			return [soup.positions[v * 3], soup.positions[v * 3 + 1], soup.positions[v * 3 + 2]];
		}
		const i = v - totalVerts;
		return [extra.positions[i * 3], extra.positions[i * 3 + 1], extra.positions[i * 3 + 2]];
	};
	const posKeyOf = new Map<number, string>();
	const keyAt = (v: number): string => {
		let k = posKeyOf.get(v);
		if (k === undefined) {
			const p = posAt(v);
			k = weldKey(p[0], p[1], p[2]);
			posKeyOf.set(v, k);
		}
		return k;
	};

	// 2. 链成环（按量化位置键链接：相邻面顶点不共享也能闭合；开口链 = 输入非流形/开口）
	const vertexEdges = new Map<string, string[]>();
	for (const key of boundary) {
		const [a, b] = edgeVerts.get(key)!;
		const ka = keyAt(a);
		const kb = keyAt(b);
		if (ka === kb) continue; // 退化边（两端量化同位）
		const la = vertexEdges.get(ka);
		if (la) la.push(key);
		else vertexEdges.set(ka, [key]);
		const lb = vertexEdges.get(kb);
		if (lb) lb.push(key);
		else vertexEdges.set(kb, [key]);
	}
	const used = new Set<string>();
	const rings: number[][] = [];
	let openChains = 0;
	for (const startKey of boundary) {
		if (used.has(startKey)) continue;
		used.add(startKey);
		const [sa, sb] = edgeVerts.get(startKey)!;
		const ringKeys = [keyAt(sa), keyAt(sb)];
		const ring = [sa, sb];
		walk: for (;;) {
			const tailKey = ringKeys[ringKeys.length - 1];
			for (const key of vertexEdges.get(tailKey) ?? []) {
				if (used.has(key)) continue;
				used.add(key);
				const [a, b] = edgeVerts.get(key)!;
				const nextKey = keyAt(a) === tailKey ? keyAt(b) : keyAt(a);
				if (nextKey === tailKey) continue; // 退化端点
				ringKeys.push(nextKey);
				ring.push(keyAt(a) === tailKey ? b : a);
				continue walk;
			}
			break;
		}
		if (ringKeys.length >= 3 && ringKeys[0] === ringKeys[ringKeys.length - 1]) {
			ring.pop();
			// 去除量化同位的连续重复顶点
			const dedup: number[] = [];
			for (let i = 0; i < ring.length; i++) {
				if (i === 0 || keyAt(ring[i]) !== keyAt(ring[i - 1])) dedup.push(ring[i]);
			}
			if (dedup.length >= 3) rings.push(dedup);
		} else {
			openChains++;
		}
	}
	if (openChains > 0) {
		warnings.push(
			warn('NON_MANIFOLD_INPUT', `截面边界存在 ${openChains} 条未闭合链（输入网格开口/非流形），对应区域不封口`),
		);
	}
	if (rings.length === 0) return 0;

	// 3. 平面 2D 基（绕向无关，仅用于 earcut）
	const [cnx, cny, cnz] = capNormal; // 与平面法线反向/同向皆可作为 z 轴
	const uAxis = Math.abs(cnx) >= Math.abs(cny) && Math.abs(cnx) >= Math.abs(cnz) ? [0, 1, 0] : [1, 0, 0];
	const vAxis = [
		cny * uAxis[2] - cnz * uAxis[1],
		cnz * uAxis[0] - cnx * uAxis[2],
		cnx * uAxis[1] - cny * uAxis[0],
	];
	const to2D = (p: [number, number, number]): [number, number] => [
		p[0] * uAxis[0] + p[1] * uAxis[1] + p[2] * uAxis[2],
		p[0] * vAxis[0] + p[1] * vAxis[1] + p[2] * vAxis[2],
	];

	interface Ring {
		verts: number[];
		coords: number[];
		area: number;
		centroid: [number, number];
	}
	const ringData: Ring[] = rings.map((verts) => {
		const coords: number[] = [];
		let area = 0;
		let cx = 0;
		let cy = 0;
		const pts = verts.map((v) => to2D(posAt(v)));
		for (let i = 0; i < pts.length; i++) {
			const p = pts[i];
			const q = pts[(i + 1) % pts.length];
			area += p[0] * q[1] - q[0] * p[1];
			cx += p[0];
			cy += p[1];
		}
		if (area < 0) {
			verts.reverse();
			coords.length = 0;
			area = 0;
			for (let i = 0; i < verts.length; i++) {
				const p = to2D(posAt(verts[i]));
				const q = to2D(posAt(verts[(i + 1) % verts.length]));
				area += p[0] * q[1] - q[0] * p[1];
				coords.push(p[0], p[1]);
			}
		} else {
			for (const p of pts) coords.push(p[0], p[1]);
		}
		return { verts, coords, area: area / 2, centroid: [cx / pts.length, cy / pts.length] };
	});

	// 4. 嵌套：每环找「包含它的最小环」为父；无父者为外环，外环的直接子环为洞
	const contains = (outer: Ring, px: number, py: number): boolean => {
		let inside = false;
		const c = outer.coords;
		const n = outer.verts.length;
		for (let i = 0, j = n - 1; i < n; j = i++) {
			const xi = c[i * 2];
			const yi = c[i * 2 + 1];
			const xj = c[j * 2];
			const yj = c[j * 2 + 1];
			if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
		}
		return inside;
	};
	const parentOf = new Map<number, number>();
	for (let i = 0; i < ringData.length; i++) {
		let parent = -1;
		let parentArea = Infinity;
		const [px, py] = ringData[i].centroid;
		for (let j = 0; j < ringData.length; j++) {
			if (i === j) continue;
			if (contains(ringData[j], px, py) && Math.abs(ringData[j].area) < parentArea) {
				parentArea = Math.abs(ringData[j].area);
				parent = j;
			}
		}
		parentOf.set(i, parent);
	}

	// 5. 外环 + 洞 → earcut（+ Delaunay 精化）
	const triangles: number[] = [];
	for (let i = 0; i < ringData.length; i++) {
		if (parentOf.get(i) !== -1) continue;
		const outer = ringData[i];
		const holes = ringData.filter((_, idx) => parentOf.get(idx) === i);
		const flat2: number[] = [...outer.coords];
		const holeIndices: number[] = [];
		for (const h of holes) {
			holeIndices.push(flat2.length / 2);
			flat2.push(...h.coords);
		}
		const tris = earcut(flat2, holeIndices.length ? holeIndices : null, 2);
		try {
			earcutRefine(tris, flat2, 2);
		} catch {
			// 精化失败不影响正确性
		}
		const allVerts = [...outer.verts, ...holes.flatMap((h) => h.verts)];
		for (let k = 0; k < tris.length; k += 3) {
			triangles.push(allVerts[tris[k]], allVerts[tris[k + 1]], allVerts[tris[k + 2]]);
		}
	}

	// 6. 封口顶点独立复制（法线 = ±n，保证截面平直着色），统一绕向后按多数源 primitive 归组
	const dupOf = new Map<number, number>();
	const dup = (v: number): number => {
		const cached = dupOf.get(v);
		if (cached !== undefined) return cached;
		const p = posAt(v);
		const id = totalVerts + extra.positions.length / 3;
		extra.positions.push(p[0], p[1], p[2]);
		if (extra.normals) extra.normals.push(capNormal[0], capNormal[1], capNormal[2]);
		if (extra.uvs) {
			const uv =
				v < totalVerts
					? [soup.uvs![v * 2], soup.uvs![v * 2 + 1]]
					: [extra.uvs![(v - totalVerts) * 2], extra.uvs![(v - totalVerts) * 2 + 1]];
			extra.uvs.push(uv[0], uv[1]);
		}
		dupOf.set(v, id);
		return id;
	};
	const outTris: number[] = [];
	let fragments = 0;
	for (let k = 0; k < triangles.length; k += 3) {
		const va = posAt(triangles[k]);
		const vb = posAt(triangles[k + 1]);
		const vc = posAt(triangles[k + 2]);
		const e1x = vb[0] - va[0];
		const e1y = vb[1] - va[1];
		const e1z = vb[2] - va[2];
		const e2x = vc[0] - va[0];
		const e2y = vc[1] - va[1];
		const e2z = vc[2] - va[2];
		const gx = e1y * e2z - e1z * e2y;
		const gy = e1z * e2x - e1x * e2z;
		const gz = e1x * e2y - e1y * e2x;
		const gl = Math.hypot(gx, gy, gz);
		// 坑 6：零面积碎片保留（删除会在壳上开洞），仅计数告警
		if (gl < 1e-12) {
			fragments++;
			outTris.push(dup(triangles[k]), dup(triangles[k + 1]), dup(triangles[k + 2]));
			continue;
		}
		const forward = (gx * capNormal[0] + gy * capNormal[1] + gz * capNormal[2]) / gl >= 0;
		const [i0, i1, i2] = forward
			? [triangles[k], triangles[k + 1], triangles[k + 2]]
			: [triangles[k], triangles[k + 2], triangles[k + 1]];
		outTris.push(dup(i0), dup(i1), dup(i2));
	}
	if (fragments > 0) {
		warnings.push(
			warn('FRAGMENT_FACES_KEPT', `截面三角化产生 ${fragments} 个零面积碎片三角形，已原样保留（渲染不可见，删除会在壳上开洞）`),
		);
	}
	if (outTris.length === 0) return 0;

	// 归入该侧多数源 primitive（跨子网格的截面在输出端共享材质组即可）
	let majorityPrim = 0;
	let majorityCount = -1;
	for (const [prim, tris] of groups) {
		if (tris.length > majorityCount) {
			majorityCount = tris.length;
			majorityPrim = prim;
		}
	}
	const list = groups.get(majorityPrim) ?? [];
	list.push(...outTris);
	groups.set(majorityPrim, list);
	return outTris.length / 3;
}

// ---------------------------------------------------------------------------
// 输出 Document 构建
// ---------------------------------------------------------------------------

/**
 * 由平面切割结果构建输出 Document（独立 GLB，每部件一个节点）。
 * 材质深拷贝（坑 1）；opts.doubleSided 强制双面（坑 3）。
 */
export function buildPlanePartsDocument(
	sourceDoc: Document,
	soup: Soup,
	cut: PlaneCutResult,
	opts: { doubleSided?: boolean } = {},
): Document {
	const target = new Document();
	const needed = new Set<Material>();
	for (const part of cut.parts) {
		for (const g of part.groups) {
			const mat = soup.prims[g.primIndex].material;
			if (mat) needed.add(mat);
		}
	}
	const matMap = copyMaterials(target, sourceDoc, needed);

	const scene = target.createScene('parts');
	const buffer = target.createBuffer('meshify');
	const ex = cut.extra;
	const hasN = !!soup.normals && !!ex.normals;
	const hasU = !!soup.uvs && !!ex.uvs;
	const posOf = (v: number): [number, number, number] =>
		v < cut.totalVerts
			? [soup.positions[v * 3], soup.positions[v * 3 + 1], soup.positions[v * 3 + 2]]
			: [
					ex.positions[(v - cut.totalVerts) * 3],
					ex.positions[(v - cut.totalVerts) * 3 + 1],
					ex.positions[(v - cut.totalVerts) * 3 + 2],
				];

	for (const part of cut.parts) {
		const node = target.createNode(part.name);
		const mesh = target.createMesh(part.name);
		node.setMesh(mesh);
		scene.addChild(node);
		for (const g of part.groups) {
			const remap = new Map<number, number>();
			const used: number[] = [];
			const indices = new Uint32Array((g.tris.length / 3) * 3);
			for (let t = 0; t < g.tris.length / 3; t++) {
				for (let k = 0; k < 3; k++) {
					const gv = g.tris[t * 3 + k];
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
			const normals = hasN ? new Float32Array(used.length * 3) : null;
			const uvs = hasU ? new Float32Array(used.length * 2) : null;
			for (let i = 0; i < used.length; i++) {
				const gv = used[i];
				const p = posOf(gv);
				positions[i * 3] = p[0];
				positions[i * 3 + 1] = p[1];
				positions[i * 3 + 2] = p[2];
				if (normals) {
					if (gv < cut.totalVerts) {
						normals[i * 3] = soup.normals![gv * 3];
						normals[i * 3 + 1] = soup.normals![gv * 3 + 1];
						normals[i * 3 + 2] = soup.normals![gv * 3 + 2];
					} else {
						const j = (gv - cut.totalVerts) * 3;
						normals[i * 3] = ex.normals![j];
						normals[i * 3 + 1] = ex.normals![j + 1];
						normals[i * 3 + 2] = ex.normals![j + 2];
					}
				}
				if (uvs) {
					if (gv < cut.totalVerts) {
						uvs[i * 2] = soup.uvs![gv * 2];
						uvs[i * 2 + 1] = soup.uvs![gv * 2 + 1];
					} else {
						const j = (gv - cut.totalVerts) * 2;
						uvs[i * 2] = ex.uvs![j];
						uvs[i * 2 + 1] = ex.uvs![j + 1];
					}
				}
			}
			const prim = target.createPrimitive();
			prim.setAttribute(
				'POSITION',
				target.createAccessor().setType('VEC3').setArray(positions).setBuffer(buffer),
			);
			if (normals) {
				prim.setAttribute(
					'NORMAL',
					target.createAccessor().setType('VEC3').setArray(normals).setBuffer(buffer),
				);
			}
			if (uvs) {
				prim.setAttribute(
					'TEXCOORD_0',
					target.createAccessor().setType('VEC2').setArray(uvs).setBuffer(buffer),
				);
			}
			prim.setIndices(target.createAccessor().setType('SCALAR').setArray(indices).setBuffer(buffer));
			const srcMat = soup.prims[g.primIndex].material;
			if (srcMat) {
				const dstMat = matMap.get(srcMat);
				if (dstMat) {
					if (opts.doubleSided) dstMat.setDoubleSided(true);
					prim.setMaterial(dstMat);
				}
			}
			mesh.addPrimitive(prim);
		}
	}
	return target;
}
