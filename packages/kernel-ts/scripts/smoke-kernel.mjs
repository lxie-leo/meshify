// 内核冒烟测试：构造多材质 GLB → inspect/simplify/segment(plane/connected/semantic)/texture/convert/optimize
// 运行：node scripts/smoke-kernel.mjs（在仓库根）
import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptEncoder } from 'meshoptimizer';
import fs from 'node:fs';
import path from 'node:path';

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
	'meshopt.encoder': MeshoptEncoder,
});

// ---- 1. 构造测试模型：两个立方体（不同材质）+ 一个八面体，其中一个立方体远离 ----
function box(cx, cy, cz, s) {
	// 24 顶点标准立方体（每面独立 4 顶点，含法线/UV）
	const p = [];
	const n = [];
	const uv = [];
	const idx = [];
	const faces = [
		{ n: [0, 0, 1], corners: [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]] },
		{ n: [0, 0, -1], corners: [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]] },
		{ n: [0, 1, 0], corners: [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1]] },
		{ n: [0, -1, 0], corners: [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]] },
		{ n: [1, 0, 0], corners: [[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1]] },
		{ n: [-1, 0, 0], corners: [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]] },
	];
	let vo = 0;
	for (const f of faces) {
		for (const c of f.corners) {
			p.push(cx + c[0] * s, cy + c[1] * s, cz + c[2] * s);
			n.push(...f.n);
		}
		uv.push(0, 0, 1, 0, 1, 1, 0, 1);
		idx.push(vo, vo + 1, vo + 2, vo, vo + 2, vo + 3);
		vo += 4;
	}
	return { p: new Float32Array(p), n: new Float32Array(n), uv: new Float32Array(uv), idx: new Uint32Array(idx) };
}

function octa(cx, cy, cz, s) {
	const v = [
		[cx, cy + s, cz], [cx, cy - s, cz], [cx, cy, cz + s], [cx + s, cy, cz], [cx, cy, cz - s], [cx - s, cy, cz],
	];
	const tris = [0, 2, 3, 0, 3, 4, 0, 4, 5, 0, 5, 2, 1, 3, 2, 1, 4, 3, 1, 5, 4, 1, 2, 5];
	const p = new Float32Array(v.flat());
	const idx = new Uint32Array(tris);
	return { p, idx };
}

const doc = new Document();
const scene = doc.createScene('scene');
const buffer = doc.createBuffer('buf');
const matA = doc.createMaterial('red').setBaseColorFactor([0.8, 0.1, 0.1, 1]);
const matB = doc.createMaterial('blue').setBaseColorFactor([0.1, 0.2, 0.8, 1]);
const matC = doc.createMaterial('green').setBaseColorFactor([0.1, 0.7, 0.2, 1]);

function addMesh(name, geo, mat) {
	const node = doc.createNode(name);
	const mesh = doc.createMesh(name);
	node.setMesh(mesh);
	scene.addChild(node);
	const prim = doc.createPrimitive();
	prim.setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(geo.p).setBuffer(buffer));
	if (geo.n) prim.setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(geo.n).setBuffer(buffer));
	if (geo.uv) prim.setAttribute('TEXCOORD_0', doc.createAccessor().setType('VEC2').setArray(geo.uv).setBuffer(buffer));
	prim.setIndices(doc.createAccessor().setType('SCALAR').setArray(geo.idx).setBuffer(buffer));
	prim.setMaterial(mat);
	mesh.addPrimitive(prim);
}

addMesh('boxA', box(0, 0, 0, 1), matA);       // 原点立方体
addMesh('boxB', box(0, 0, 0, 1.0000001), matB); // 重叠立方体（跨子网格焊接测试：量化后同位置）
addMesh('octa', octa(5, 0, 0, 1), matC);       // 远离的八面体

const tmp = path.resolve('fixtures/generated');
fs.mkdirSync(tmp, { recursive: true });
const modelPath = path.join(tmp, 'smoke.glb');
await io.write(modelPath, doc);
console.log('1) 测试模型已写入', modelPath, fs.statSync(modelPath).size, 'bytes');

// ---- 2. 内核链 ----
const k = await import('../dist/index.js');

const read = await k.createIO();
const d2 = await read.read(modelPath);

// inspect
const insp = await k.inspectDocument(d2);
console.log('2) inspect:', JSON.stringify({
	meshes: insp.meshes.length, vertices: insp.vertices, faces: insp.faces,
	materials: insp.materials, bbox: insp.bbox?.map((a) => a.map((x) => +x.toFixed(2))),
}));

// simplify（boxB 12 面 < 200 会跳过并告警）
const sim = await k.simplifyDocument(d2, { ratio: 0.5 });
console.log('3) simplify:', sim.facesBefore, '->', sim.facesAfter, 'warn:', sim.warnings.map((w) => w.code));

// segment plane A：单立方体（24 顶点未焊接——CAD 导出常态，验证位置键封口）
const single = new Document();
const sScene = single.createScene('scene');
const sBuf = single.createBuffer('buf');
const sMat = single.createMaterial('mat').setBaseColorFactor([0.8, 0.1, 0.1, 1]);
const sNode = single.createNode('box');
const sMesh = single.createMesh('box');
sNode.setMesh(sMesh);
sScene.addChild(sNode);
const g = box(0, 0, 0, 1);
const sPrim = single.createPrimitive();
sPrim.setAttribute('POSITION', single.createAccessor().setType('VEC3').setArray(g.p).setBuffer(sBuf));
sPrim.setAttribute('NORMAL', single.createAccessor().setType('VEC3').setArray(g.n).setBuffer(sBuf));
sPrim.setAttribute('TEXCOORD_0', single.createAccessor().setType('VEC2').setArray(g.uv).setBuffer(sBuf));
sPrim.setIndices(single.createAccessor().setType('SCALAR').setArray(g.idx).setBuffer(sBuf));
sPrim.setMaterial(sMat);
sMesh.addPrimitive(sPrim);
const cutModelPath = path.join(tmp, 'smoke-cut.glb');
await io.write(cutModelPath, single);
const dCut = await read.read(cutModelPath);
const soupCut = k.buildSoup(k.collectPrimitives(dCut));
const cut = k.cutSoupByPlane(soupCut, { origin: [0, 0, 0], normal: [1, 0, 0] }, { cap: true });
console.log('4) segment-plane 单盒: parts=', cut.parts.map((p) => `${p.name}:${p.triangleCount}tris`), 'capped=', cut.capped, 'warn:', cut.warnings.map((w) => w.code));
const planeDoc = k.buildPlanePartsDocument(dCut, soupCut, cut, { doubleSided: true });
const planeOut = path.join(tmp, 'smoke.plane.glb');
await read.write(planeOut, planeDoc);
console.log('   plane GLB:', fs.statSync(planeOut).size, 'bytes');

// segment plane B：多材质重叠模型（坑 1：按源 primitive 分组保留；重合壳显式披露不封口）
const soup = k.buildSoup(k.collectPrimitives(d2));
const cut2 = k.cutSoupByPlane(soup, { origin: [0, 0, 0], normal: [1, 0, 0] }, { cap: true });
console.log('4b) segment-plane 多材质: parts=', cut2.parts.map((p) => `${p.name}:${p.triangleCount}tris/groups${p.groups.length}`), 'capped=', cut2.capped, 'warn:', cut2.warnings.map((w) => w.code));

// segment connected（boxA+boxB 焊接成一体 + 八面体 → 2 部件）
const conn = k.segmentConnected(soup, { minFaces: 5 });
console.log('5) segment-connected: parts=', conn.parts.map((p) => p.name + ':' + p.groups.reduce((s, g) => s + g.triangles.length, 0)), 'total=', conn.totalComponents, 'warn:', conn.warnings.map((w) => w.code));

// segment semantic
const sem = k.segmentSemantic(soup, { clusters: 4 });
console.log('6) segment-semantic: parts=', sem.parts.map((p) => p.name + ':' + p.groups.reduce((s, g) => s + g.triangles.length, 0)), 'colors:', sem.partColors.length, 'solids=', sem.totalComponents);

// texture（box 投影重生成 UV）
const d3 = await read.read(modelPath);
const tex = k.textureDocument(d3, { mode: 'box' });
console.log('7) texture box:', tex.meshes.map((m) => `${m.name}:${m.mode}`), 'warn:', tex.warnings.map((w) => w.code));

// convert：GLB → STL / PLY / OBJ
const stlBytes = k.documentToStl(d3);
fs.writeFileSync(path.join(tmp, 'smoke.stl'), stlBytes);
const plyText = k.documentToPly(d3);
fs.writeFileSync(path.join(tmp, 'smoke.ply'), plyText);
const objExp = await k.documentToObj(d3);
fs.writeFileSync(path.join(tmp, 'smoke.obj'), objExp.obj);
if (objExp.mtl) fs.writeFileSync(path.join(tmp, 'smoke.mtl'), objExp.mtl);
console.log('8) convert out: stl', stlBytes.length, 'B; ply', plyText.length, 'ch; obj', objExp.obj.length, 'ch; mtl?', !!objExp.mtl);

// 读回验证：STL/PLY → Document → inspect
const stlDoc = k.stlToDocument(new Uint8Array(fs.readFileSync(path.join(tmp, 'smoke.stl'))));
const plyDoc = k.plyToDocument(new Uint8Array(fs.readFileSync(path.join(tmp, 'smoke.ply'))));
const objBytes = fs.readFileSync(path.join(tmp, 'smoke.obj'));
const objLoaded = k.objToDocument(objBytes.toString('utf8'), null, new Map());
const objDoc = objLoaded.doc;
console.log('9) 读回: stl verts=', (await k.inspectDocument(stlDoc)).vertices,
	'ply faces=', (await k.inspectDocument(plyDoc)).faces,
	'obj meshes=', (await k.inspectDocument(objDoc)).meshes.length);

// lod
const lod = await k.generateLodLevels(d3, { levels: 3, ratio: 0.5 });
console.log('10) lod:', lod.levels.map((l) => `L${l.level}:${l.faces}`));

// optimize（贴图 webp 无贴图则跳过；codec meshopt）
const d4 = await read.read(modelPath);
const opt = await k.optimizeDocument(d4, { ratio: 0.8, codec: 'meshopt' });
const optOut = path.join(tmp, 'smoke.optimized.glb');
await read.write(optOut, d4);
console.log('11) optimize:', opt.facesBefore, '->', opt.facesAfter, 'codec=', opt.codecApplied, fs.statSync(optOut).size, 'bytes');

console.log('SMOKE OK');
