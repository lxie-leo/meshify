// fixtures 生成器 —— golden 模型集（坑样本齐备，plan.md L277）
//
//   node fixtures/generate.mjs            # 全量（Tier0/GLB 系列 + uv 可用时生成 STEP）
//   node fixtures/generate.mjs --big      # 追加 >500 万面大网格（资源防护样本，~150MB，慢）
//
// 全部程序化生成（无外部资产依赖）：PNG 走自带 zlib 编码器，几何走自带生成器，
// STEP 用 kernel-py 的 OCC 内核（uv 不可用时跳过并提示）。

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { NodeIO, Document } from '@gltf-transform/core';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const FIX = path.join(ROOT, 'fixtures');
const BIG = process.argv.includes('--big');

// ------------------------------------------------------------------
// 极简 PNG 编码器（RGBA8，无外部依赖；fixtures 生成不依赖 sharp）
// ------------------------------------------------------------------
const CRC_TABLE = (() => {
	const t = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[n] = c >>> 0;
	}
	return t;
})();

function crc32(buf) {
	let c = 0xffffffff;
	for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
	const out = Buffer.alloc(12 + data.length);
	out.writeUInt32BE(data.length, 0);
	out.write(type, 4, 'ascii');
	data.copy(out, 8);
	out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 8 + data.length);
	return out;
}

/** size×size 棋盘格 + 对角渐变 PNG（贴图样本；近白亮度供预览曝光逻辑测试）。 */
function checkerPng(size = 64) {
	const raw = Buffer.alloc((size * 4 + 1) * size); // RGBA：filter 字节 + size*4
	let o = 0;
	for (let y = 0; y < size; y++) {
		raw[o++] = 0; // filter none
		for (let x = 0; x < size; x++) {
			const checker = ((x >> 4) + (y >> 4)) % 2 === 0;
			const grad = Math.floor(200 * (x + y) / (2 * size));
			raw[o++] = checker ? 235 : 40;   // R
			raw[o++] = checker ? grad : 30;  // G
			raw[o++] = checker ? 60 : 200;   // B
			raw[o++] = 255;                  // A
		}
	}
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(size, 0);
	ihdr.writeUInt32BE(size, 4);
	ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', ihdr),
		chunk('IDAT', zlib.deflateSync(raw)),
		chunk('IEND', Buffer.alloc(0)),
	]);
}

// ------------------------------------------------------------------
// 几何生成器（位置/法线/UV/索引，右手系，单位长量级）
// ------------------------------------------------------------------
function boxGeom(w, h, d, { uv = true } = {}) {
	const x = w / 2, y = h / 2, z = d / 2;
	const faces = [
		{ n: [0, 0, 1], c: [[-x, -y, z], [x, -y, z], [x, y, z], [-x, y, z]] },
		{ n: [0, 0, -1], c: [[x, -y, -z], [-x, -y, -z], [-x, y, -z], [x, y, -z]] },
		{ n: [1, 0, 0], c: [[x, -y, z], [x, -y, -z], [x, y, -z], [x, y, z]] },
		{ n: [-1, 0, 0], c: [[-x, -y, -z], [-x, -y, z], [-x, y, z], [-x, y, -z]] },
		{ n: [0, 1, 0], c: [[-x, y, z], [x, y, z], [x, y, -z], [-x, y, -z]] },
		{ n: [0, -1, 0], c: [[-x, -y, -z], [x, -y, -z], [x, -y, z], [-x, -y, z]] },
	];
	const positions = [], normals = [], uvs = [], indices = [];
	let vi = 0;
	for (const f of faces) {
		for (const p of f.c) { positions.push(...p); normals.push(...f.n); }
		if (uv) uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
		indices.push(vi, vi + 1, vi + 2, vi, vi + 2, vi + 3);
		vi += 4;
	}
	return {
		positions: new Float32Array(positions), normals: new Float32Array(normals),
		uvs: uv ? new Float32Array(uvs) : null, indices: new Uint32Array(indices),
	};
}

/** 开口壳：去掉顶面的盒子（坑 3 样本——分割/贴图产物需双面材质）。 */
function openShellGeom(w, h, d) {
	const g = boxGeom(w, h, d);
	// 顶面是第 5 组（每面 4 顶点 6 索引）：剥掉它
	const positions = g.positions.slice(0, 48); // 16 顶点
	const normals = g.normals.slice(0, 48);
	const uvs = g.uvs.slice(0, 32);
	return {
		positions, normals, uvs,
		indices: new Uint32Array(Array.from(g.indices).filter((_, i) => i < 24 || i >= 30)),
	};
}

/** 测地球（二十面体细分；subdiv=n → 20×4^n 面，水密）。 */
function icosphere(subdiv) {
	const t = (1 + Math.sqrt(5)) / 2;
	let verts = [
		[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
		[0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
		[t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
	].map(([x, y, z]) => {
		const l = Math.hypot(x, y, z);
		return [x / l, y / l, z / l];
	});
	let faces = [
		[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
		[1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
		[3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
		[4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
	];
	for (let s = 0; s < subdiv; s++) {
		const cache = new Map();
		const mid = (a, b) => {
			const key = a < b ? `${a}_${b}` : `${b}_${a}`;
			if (cache.has(key)) return cache.get(key);
			const [ax, ay, az] = verts[a], [bx, by, bz] = verts[b];
			let mx = (ax + bx) / 2, my = (ay + by) / 2, mz = (az + bz) / 2;
			const l = Math.hypot(mx, my, mz);
			verts.push([mx / l, my / l, mz / l]);
			const i = verts.length - 1;
			cache.set(key, i);
			return i;
		};
		const next = [];
		for (const [a, b, c] of faces) {
			const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a);
			next.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
		}
		faces = next;
	}
	const positions = new Float32Array(verts.flat());
	const normals = new Float32Array(verts.flat()); // 单位球：法线=位置
	const uvs = new Float32Array(verts.length * 2);
	for (let i = 0; i < verts.length; i++) {
		const [x, , z] = verts[i];
		uvs[2 * i] = 0.5 + Math.atan2(z, x) / (2 * Math.PI);
		uvs[2 * i + 1] = 0.5 - Math.asin(verts[i][1]) / Math.PI;
	}
	return { positions, normals, uvs, indices: new Uint32Array(faces.flat()) };
}

/** 二十面体（20 面；< min-faces=200 → SMALL_MESH_SKIPPED 样本）。 */
function icosahedronGeom() {
	return icosphere(0);
}

// ------------------------------------------------------------------
// glTF 文档组装
// ------------------------------------------------------------------
function makeDoc() { return new Document(); }

/** 访问器创建助手：统一绑定文档首个 buffer（glTF 要求访问器显式挂 buffer）。 */
function acc(doc, type, array) {
	const buffer = doc.getRoot().listBuffers()[0] ?? doc.createBuffer();
	return doc.createAccessor().setType(type).setArray(array).setBuffer(buffer);
}

function addPrimitive(doc, name, geom, material, translation, scene) {
	const prim = doc.createPrimitive();
	prim.setAttribute('POSITION', acc(doc, 'VEC3', geom.positions));
	prim.setAttribute('NORMAL', acc(doc, 'VEC3', geom.normals));
	if (geom.uvs) prim.setAttribute('TEXCOORD_0', acc(doc, 'VEC2', geom.uvs));
	prim.setIndices(acc(doc, 'SCALAR', geom.indices));
	if (material) prim.setMaterial(material); // 材质必须挂到 primitive：孤儿材质测不到坑 1/坑 2 路径
	const mesh = doc.createMesh(name).addPrimitive(prim);
	const node = doc.createNode(name).setMesh(mesh).setTranslation(translation ?? [0, 0, 0]);
	// 复用首个 scene（未显式指定时）：每次 createScene 会产出多 scene GLB——
	// trimesh 只挂默认 scene，Tier1 会把其余 scene 的几何丢成孤儿
	const target = scene ?? doc.getRoot().listScenes()[0] ?? doc.createScene('Scene');
	target.addChild(node);
	return node;
}

async function writeGlb(doc, file) {
	if (doc.getRoot().listBuffers().length === 0) doc.createBuffer(); // 访问器需要至少一个 buffer
	const io = new NodeIO();
	const bytes = await io.writeBinary(doc);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, bytes);
	console.log(`  [ok] ${path.relative(ROOT, file)}  ${bytes.length}B`);
}

/** 带皮肤 + 动画的 GLB（路由样本：has_animation → 强制 Tier0 + SKIN_ANIMATION_PRESERVED）。 */
function skinAnimDoc() {
	const doc = makeDoc();
	const geom = icosphere(2); // 320 面
	// 关节：root(0,0,0) → arm(1.5,0,0)
	const jRoot = doc.createNode('joint_root');
	const jArm = doc.createNode('joint_arm').setTranslation([1.5, 0, 0]);
	jRoot.addChild(jArm);
		// 蒙皮网格：JOINTS_0 全 0（绑 root）、WEIGHTS_0 全 (1,0,0,0)
	const n = geom.positions.length / 3;
	const joints = new Uint16Array(n * 4);
	const weights = new Float32Array(n * 4);
	for (let i = 0; i < n; i++) weights[4 * i] = 1;
	const prim = doc.createPrimitive()
		.setAttribute('POSITION', acc(doc, 'VEC3', geom.positions))
		.setAttribute('NORMAL', acc(doc, 'VEC3', geom.normals))
		.setAttribute('TEXCOORD_0', acc(doc, 'VEC2', geom.uvs))
		.setAttribute('JOINTS_0', acc(doc, 'VEC4', joints))
		.setAttribute('WEIGHTS_0', acc(doc, 'VEC4', weights))
		.setIndices(acc(doc, 'SCALAR', geom.indices));
	const meshNode = doc.createNode('skinned').setMesh(doc.createMesh('skinned').addPrimitive(prim)).setSkin(null);
	// 逆绑定矩阵：单位阵 ×2（root 在原点）
	const ibm = new Float32Array(16); ibm[0] = ibm[5] = ibm[10] = ibm[15] = 1;
	const skin = doc.createSkin('Armature')
		.addJoint(jRoot).addJoint(jArm)
		.setInverseBindMatrices(acc(doc, 'MAT4', ibm));
	meshNode.setSkin(skin);
	doc.createScene('Scene').addChild(meshNode).addChild(jRoot);
	// 动画：arm 绕 Z 摆动 0→π/4→0（1s，3 关键帧）
	const input = acc(doc, 'SCALAR', new Float32Array([0, 0.5, 1]));
	const q = (rad) => [Math.sin(rad / 2), 0, 0, Math.cos(rad / 2)];
	const output = doc.createAccessor().setType('VEC4').setArray(new Float32Array([...q(0), ...q(Math.PI / 4), ...q(0)]));
	const sampler = doc.createAnimationSampler().setInput(input).setOutput(output).setInterpolation('LINEAR');
	doc.createAnimation('swing')
		.addChannel(doc.createAnimationChannel().setTargetNode(jArm).setTargetPath('rotation').setSampler(sampler))
		.addSampler(sampler);
	return doc;
}

/** 二进制 STL（无材质样本）。 */
function stlCube(file, size = 1) {
	const g = boxGeom(size, size, size);
	const triangles = g.indices.length / 3;
	const buf = Buffer.alloc(84 + 50 * triangles);
	buf.write('meshify stl fixture', 0, 'ascii');
	buf.writeUInt32LE(triangles, 80);
	let o = 84;
	const P = (i) => [g.positions[3 * i], g.positions[3 * i + 1], g.positions[3 * i + 2]];
	for (let t = 0; t < triangles; t++) {
		const [a, b, c] = [P(g.indices[3 * t]), P(g.indices[3 * t + 1]), P(g.indices[3 * t + 2])];
		buf.writeFloatLE(0, o); buf.writeFloatLE(0, o + 4); buf.writeFloatLE(0, o + 8); // 法线留给读取器重算路径测试
		o += 12;
		for (const p of [a, b, c]) { buf.writeFloatLE(p[0], o); buf.writeFloatLE(p[1], o + 4); buf.writeFloatLE(p[2], o + 8); o += 12; }
		o += 2; // attribute byte count
	}
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, buf);
	console.log(`  [ok] ${path.relative(ROOT, file)}  ${buf.length}B`);
}

/** OBJ + MTL（外部贴图引用 + 两材质，坑 1 相关样本）。 */
function objTwoMaterials(dir) {
	fs.mkdirSync(dir, { recursive: true });
	const mtl = `# meshify fixture
newmtl red_plastic
Kd 0.8 0.1 0.1
Ks 0.2 0.2 0.2
Ns 32
d 1.0
newmtl blue_plastic
Kd 0.1 0.2 0.8
Ks 0.1 0.1 0.1
Ns 8
d 1.0
`;
	const lines = ['# meshify fixture', 'mtllib two-material.mtl'];
	let vOff = 0;
	for (const [ox, mtlName] of [[-0.8, 'red_plastic'], [0.8, 'blue_plastic']]) {
		const s = 0.5;
		const verts = [
			[-s, -s, s], [s, -s, s], [s, s, s], [-s, s, s],
			[s, -s, -s], [-s, -s, -s], [-s, s, -s], [s, s, -s],
			[s, -s, s], [s, -s, -s], [s, s, -s], [s, s, s],
			[-s, -s, -s], [-s, -s, s], [-s, s, s], [-s, s, -s],
			[-s, s, s], [s, s, s], [s, s, -s], [-s, s, -s],
			[-s, -s, -s], [s, -s, -s], [s, -s, s], [-s, -s, s],
		];
		const faces = [
			[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16], [17, 18, 19, 20], [21, 22, 23, 24],
		];
		lines.push(`o part_${mtlName}`, `usemtl ${mtlName}`);
		for (const [x, y, z] of verts) lines.push(`v ${(x + ox).toFixed(4)} ${y.toFixed(4)} ${z.toFixed(4)}`);
		for (const f of faces) lines.push(`f ${(f[0] + vOff)} ${(f[1] + vOff)} ${(f[2] + vOff)} ${(f[3] + vOff)}`);
		vOff += 24;
	}
	fs.writeFileSync(path.join(dir, 'two-material.obj'), lines.join('\n') + '\n');
	fs.writeFileSync(path.join(dir, 'two-material.mtl'), mtl);
	console.log(`  [ok] ${path.relative(ROOT, path.join(dir, 'two-material.obj'))}`);
}

// ------------------------------------------------------------------
// STEP（Tier1/OCC；uv 不可用则跳过）
// ------------------------------------------------------------------
function generateStepFixtures() {
	const kernelDir = path.join(ROOT, 'packages-py', 'kernel-py');
	try {
		execFileSync('uv', ['run', '--quiet', 'python', '-X', 'utf8', '-c', [
			'import os',
			'from meshify_kernel.services.step import write_step_fixture, write_holed_base_fixture',
			`os.makedirs(${JSON.stringify(path.join(FIX, 'step').replace(/\\/g, '/'))}, exist_ok=True)`,
			// 单立方体：inspect/转换样本
			`write_step_fixture(${JSON.stringify(path.join(FIX, 'step', 'cube.step').replace(/\\/g, '/'))}, size=2.0)`,
			// 带四角孔底板的躺姿部件（--up-axis auto 判定样本）
			`write_holed_base_fixture(${JSON.stringify(path.join(FIX, 'step', 'holed-base.step').replace(/\\/g, '/'))})`,
			// 三零件装配体（多色，坑 4 样本）：底板 + 两立柱
			'import gmsh',
			'gmsh.initialize(interruptible=False)',
			'gmsh.option.setNumber("General.Terminal", 0)',
			'gmsh.model.add("assembly")',
			'gmsh.model.occ.addBox(-1.5, -1.0, -0.2, 3.0, 2.0, 0.4)',
			'gmsh.model.occ.addBox(-1.3, -0.8, 0.2, 0.5, 0.5, 1.5)',
			'gmsh.model.occ.addBox(0.8, 0.3, 0.2, 0.5, 0.5, 1.8)',
			'gmsh.model.occ.synchronize()',
			'tags = gmsh.model.getEntities(3)',
			'gmsh.model.setColor([tags[0]], 120, 130, 140)',
			'gmsh.model.setColor([tags[1]], 200, 80, 60)',
			'gmsh.model.setColor([tags[2]], 60, 120, 200)',
			`gmsh.write(${JSON.stringify(path.join(FIX, 'step', 'assembly.step').replace(/\\/g, '/'))})`,
			'gmsh.clear()',
			'gmsh.finalize()',
			'print("step fixtures ok")',
		].join('\n')], { cwd: kernelDir, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } });
		console.log('  [ok] step/cube.step + step/holed-base.step + step/assembly.step（OCC 生成）');
	} catch (e) {
		console.log('  [--] STEP fixtures 跳过（uv 不可用）:', String(e.stderr ?? e.message).slice(0, 120));
	}
}

// ------------------------------------------------------------------
// 主流程
// ------------------------------------------------------------------
console.log('生成 fixtures …');
fs.mkdirSync(FIX, { recursive: true });

// 1. 多材质多子网格 GLB（坑 1/2）
{
	const doc = makeDoc();
	const tex = doc.createTexture('checker').setImage(checkerPng()).setMimeType('image/png');
	const matA = doc.createMaterial('mat_A').setBaseColorTexture(tex).setMetallicFactor(0).setRoughnessFactor(0.9);
	const matB = doc.createMaterial('mat_B').setBaseColorTexture(tex).setMetallicFactor(0.2).setRoughnessFactor(0.5); // 同贴图不同材质（坑 2 采样近似）
	const matC = doc.createMaterial('mat_C').setBaseColorFactor([0.9, 0.5, 0.1, 1]).setMetallicFactor(0).setRoughnessFactor(0.8);
	addPrimitive(doc, 'textured_a', boxGeom(1, 1, 1), matA, [-1.2, 0, 0]);
	addPrimitive(doc, 'textured_b', boxGeom(0.8, 0.8, 0.8), matB, [0, 0.6, 0]);
	// 第三个子网格故意无 UV（材质纯色）：texture --map uv 时触发 AUTO_BOX_UV_GENERATED
	addPrimitive(doc, 'plain_c', boxGeom(1, 1.4, 1, { uv: false }), matC, [1.2, 0, 0]);
	await writeGlb(doc, path.join(FIX, 'glb', 'multimat.glb'));
}

// 2. 开口壳（坑 3）
{
	const doc = makeDoc();
	const mat = doc.createMaterial('shell').setBaseColorFactor([0.6, 0.7, 0.8, 1]).setDoubleSided(false);
	const g = openShellGeom(2, 1, 2);
		const prim = doc.createPrimitive()
		.setAttribute('POSITION', acc(doc, 'VEC3', g.positions))
		.setAttribute('NORMAL', acc(doc, 'VEC3', g.normals))
		.setAttribute('TEXCOORD_0', acc(doc, 'VEC2', g.uvs))
		.setIndices(acc(doc, 'SCALAR', g.indices))
		.setMaterial(mat);
	doc.createScene('Scene').addChild(doc.createNode('open_shell').setMesh(doc.createMesh('open_shell').addPrimitive(prim)));
	await writeGlb(doc, path.join(FIX, 'glb', 'open-shell.glb'));
}

// 3. 小网格（<200 面 → SMALL_MESH_SKIPPED）
{
	const doc = makeDoc();
	const mat = doc.createMaterial('tiny').setBaseColorFactor([0.8, 0.2, 0.4, 1]);
	addPrimitive(doc, 'tiny_icosa', icosahedronGeom(), mat, [0, 0, 0]);
	await writeGlb(doc, path.join(FIX, 'glb', 'small.glb'));
}

// 4. 稠密球（质量断言样本：5120 面，水密，带 UV/法线）
{
	const doc = makeDoc();
	const tex = doc.createTexture('checker').setImage(checkerPng()).setMimeType('image/png');
	const mat = doc.createMaterial('sphere_mat').setBaseColorTexture(tex).setMetallicFactor(0).setRoughnessFactor(0.7);
	addPrimitive(doc, 'dense_sphere', icosphere(4), mat, [0, 0, 0]);
	await writeGlb(doc, path.join(FIX, 'glb', 'dense.glb'));
}

// 5. 皮肤 + 动画 GLB（路由样本）
await writeGlb(skinAnimDoc(), path.join(FIX, 'glb', 'skin-anim.glb'));

// 5b. 空场景 GLB（退出码 6 样本：几何命令无可处理几何；inspect 侧 bbox=null 边界）
{
	const doc = makeDoc();
	doc.createScene('Empty');
	await writeGlb(doc, path.join(FIX, 'glb', 'empty.glb'));
}

// 5c. 多 scene GLB（非默认 scene 的几何 → Tier1 孤儿 → ORPHAN_GEOMETRY_ATTACHED 样本）
{
	const doc = makeDoc();
	const mat = doc.createMaterial('ms_mat').setBaseColorFactor([0.3, 0.8, 0.4, 1]).setMetallicFactor(0).setRoughnessFactor(0.6);
	const main = doc.createScene('Main');
	const extra = doc.createScene('Extra');
	addPrimitive(doc, 'ms_box', boxGeom(1, 1, 1), mat, [0, 0, 0], main);
	addPrimitive(doc, 'ms_sphere', icosphere(2), mat, [2.5, 0, 0], extra);
	doc.getRoot().setDefaultScene(main); // 默认 scene = Main；球挂在 Extra 上
	await writeGlb(doc, path.join(FIX, 'glb', 'multiscene.glb'));
}

// 6. STL（无材质）
stlCube(path.join(FIX, 'stl', 'cube.stl'));

// 7. OBJ + MTL（两材质外部文件）
objTwoMaterials(path.join(FIX, 'obj'));

// 8. STEP（Tier1）
generateStepFixtures();

// 9. 大网格（>500 万面；--big 显式生成）
if (BIG) {
	const doc = makeDoc();
	const mat = doc.createMaterial('big').setBaseColorFactor([0.5, 0.5, 0.6, 1]);
	addPrimitive(doc, 'big_sphere', icosphere(9), mat, [0, 0, 0]); // 20×4^9 ≈ 1310 万面
	await writeGlb(doc, path.join(FIX, 'glb', 'huge.glb'));
}

console.log('fixtures 完成');
