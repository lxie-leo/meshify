/**
 * 2026-09-03 对抗审计回归（10 项缺陷固化；修复前行为见各用例注释）。
 * 覆盖：损坏输入归一 exit 2（双内核）、大小写同文件、convert 扩展名/伴生文件、
 * py texture 无 --image、空场景统一 exit 6、STEP 全命令、merge 回退披露、
 * OBJ 越界披露、fixtures PNG 编码器（RGBA 步长）。
 */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { Document, NodeIO } from '@gltf-transform/core';
import { cli, FIX, freshDir, hasUv } from './helpers';
import { resolveKernelPyDir, isKernelSynced } from '@meshify/core';
import { objToDocument, simplifyDocument } from '@meshify/kernel-ts';

const TIER1 = () => hasUv() && isKernelSynced(resolveKernelPyDir());

// ------------------------------------------------------------------
// 审计 #5：损坏输入 → 双内核统一 exit 2（曾 ts=8 / py=6/8 漂移）
// ------------------------------------------------------------------
describe('审计回归：损坏输入归一 exit 2', () => {
	it('截断 GLB + simplify（Tier0）→ 2 + 诊断 + 最小失败 manifest（曾 exit 8 无报告）', () => {
		const dir = freshDir('audit-corrupt');
		const f = path.join(dir, 'corrupt.glb');
		fs.writeFileSync(f, fs.readFileSync(FIX('glb/dense.glb')).subarray(0, 8000));
		const r = cli(['simplify', f, '--ratio', '0.5', '-o', path.join(dir, 'o.glb'), '--json']);
		expect(r.code).toBe(2);
		expect(r.stderr).toMatch(/解析失败|不可读/);
		// 早失败最小 manifest：errors 携带原因，产物绝不出现在盘上
		expect(r.manifest?.exit_code).toBe(2);
		expect((r.manifest?.errors ?? []).join(' ')).toMatch(/解析失败|不可读/);
		expect(fs.existsSync(path.join(dir, 'o.glb'))).toBe(false);
	});

	it.runIf(TIER1())(
		'截断 GLB + simplify --tier py → 2（曾 8/6 漂移）',
		() => {
			const dir = freshDir('audit-corrupt-py');
			const f = path.join(dir, 'corrupt.glb');
			fs.writeFileSync(f, fs.readFileSync(FIX('glb/dense.glb')).subarray(0, 8000));
			const r = cli(['simplify', f, '--ratio', '0.5', '--tier', 'py', '-o', path.join(dir, 'o.glb'), '--json']);
			expect(r.code).toBe(2);
			expect((r.manifest?.errors ?? []).join(' ')).toMatch(/解析失败|不可读/);
		},
		180_000,
	);
});

// ------------------------------------------------------------------
// 审计 #3：大小写不敏感 FS 上大小写变体路径也算"同输入"（曾绕过保护直接覆盖）
// ------------------------------------------------------------------
describe('审计回归：大小写不敏感文件系统同文件保护', () => {
	it.skipIf(process.platform === 'linux')(
		'-o 仅大小写不同 → exit 4，--overwrite 也不放行',
		() => {
			const dir = freshDir('audit-case');
			const input = path.join(dir, 'Model.GLB');
			fs.copyFileSync(FIX('glb/small.glb'), input);
			const r = cli(['simplify', input, '-o', path.join(dir, 'model.glb'), '--overwrite', '--json']);
			expect(r.code).toBe(4);
			expect(r.stderr).toMatch(/输入|覆盖/);
		},
	);
});

// ------------------------------------------------------------------
// 审计 #6/#7：convert 防坏产物 + 伴生文件入 manifest.files
// ------------------------------------------------------------------
describe('审计回归：convert 输出契约', () => {
	it('-o 扩展名与 --to 不一致 → 4（曾把 STL 字节写进 .glb 名）', () => {
		const dir = freshDir('audit-convert-ext');
		const r = cli(['convert', FIX('glb/dense.glb'), '--to', 'stl', '-o', path.join(dir, 'bad.glb'), '--json']);
		expect(r.code).toBe(4);
		expect(r.stderr).toMatch(/扩展名|一致/);
		// 拒绝先于写入：产物绝不出盘（失败 report 是工具自有日志，允许落盘）
		expect(fs.readdirSync(dir).filter((f) => !f.endsWith('.report.json'))).toEqual([]);
		expect(fs.existsSync(path.join(dir, 'bad.glb'))).toBe(false);
	});

	it('--to gltf：外部 .bin 与贴图伴生逐个列入 files[]（曾只列主文件）', () => {
		const dir = freshDir('audit-convert-gltf');
		const r = cli(['convert', FIX('glb/dense.glb'), '--to', 'gltf', '-o', path.join(dir, 'd.gltf'), '--json']);
		expect(r.code).toBe(0);
		const names = (r.manifest?.output?.files ?? []).map((f: any) => path.basename(f.path));
		expect(names.filter((n: string) => n.endsWith('.gltf'))).toHaveLength(1);
		expect(names.some((n: string) => n.endsWith('.bin'))).toBe(true);
		expect(names.some((n: string) => n.endsWith('.png'))).toBe(true); // dense 自带 checker 贴图
		for (const f of r.manifest?.output?.files ?? []) {
			expect(fs.existsSync(f.path)).toBe(true); // files[] 不列幽灵文件
			expect(f.role).toBe('asset');
		}
	});

	it('--to obj：.mtl 伴生列入 files[]', () => {
		const dir = freshDir('audit-convert-obj');
		const r = cli(['convert', FIX('glb/dense.glb'), '--to', 'obj', '-o', path.join(dir, 'd.obj'), '--json']);
		expect(r.code).toBe(0);
		const names = (r.manifest?.output?.files ?? []).map((f: any) => path.basename(f.path));
		expect(names.some((n: string) => n.endsWith('.obj'))).toBe(true);
		expect(names.some((n: string) => n.endsWith('.mtl'))).toBe(true);
	});
});

// ------------------------------------------------------------------
// 审计 #2/#8：texture 参数契约
// ------------------------------------------------------------------
describe('审计回归：texture 参数契约', () => {
	it('--image 不是可解码图片 → exit 2（曾裸 exit 1 无诊断）', () => {
		const dir = freshDir('audit-tex-image');
		fs.copyFileSync(FIX('glb/small.glb'), path.join(dir, 'in.glb'));
		fs.copyFileSync(FIX('glb/small.glb'), path.join(dir, 'fake.png')); // GLB 字节冒充图片
		const r = cli([
			'texture', path.join(dir, 'in.glb'), '--map', 'box',
			'--image', path.join(dir, 'fake.png'),
			'-o', path.join(dir, 'o.glb'), '--json',
		]);
		expect(r.code).toBe(2);
		expect(r.stderr).toMatch(/--image|解码|图片/);
	});

	it.runIf(TIER1())(
		'Tier1 texture 无 --image → exit 0（仅重生成 UV；曾参数错误 exit 4）',
		() => {
			const dir = freshDir('audit-tex-noimage');
			const r = cli([
				'texture', FIX('glb/dense.glb'), '--map', 'box', '--tier', 'py',
				'-o', path.join(dir, 'o.glb'), '--overwrite', '--json',
			]);
			expect(r.code).toBe(0);
			expect(r.manifest?.tool?.tier).toBe('python-uv');
		},
		180_000,
	);
});

// ------------------------------------------------------------------
// 审计 #9（部分）：空场景 × 几何命令统一 exit 6（曾 simplify=0 / segment=6 漂移）
// ------------------------------------------------------------------
describe('审计回归：空场景（0 面）统一 exit 6', () => {
	const cmds: string[][] = [
		['simplify', '--ratio', '0.5'],
		['texture', '--map', 'box'],
		['optimize', '--ratio', '0.5'],
		['lod', '--levels', '2'],
	];
	for (const cmd of cmds) {
		it(`empty.glb × ${cmd[0]} → exit 6`, () => {
			const dir = freshDir('audit-empty');
			const input = path.join(dir, 'empty.glb');
			fs.copyFileSync(FIX('glb/empty.glb'), input);
			const r = cli([...cmd, input, '-o', path.join(dir, 'out'), '--json']);
			expect(r.code).toBe(6);
			expect(r.stderr).toMatch(/三角面|几何/);
		});
	}

	it.runIf(TIER1())(
		'empty.glb × simplify --tier py → exit 6（py 侧同口径）',
		() => {
			const dir = freshDir('audit-empty-py');
			const input = path.join(dir, 'empty.glb');
			fs.copyFileSync(FIX('glb/empty.glb'), input);
			const r = cli(['simplify', input, '--ratio', '0.5', '--tier', 'py', '-o', path.join(dir, 'o.glb'), '--json']);
			expect(r.code).toBe(6);
		},
		180_000,
	);
});

// ------------------------------------------------------------------
// 审计 #1：STEP × 全命令（曾 simplify/segment/texture/optimize exit 8，lod 吐坏 GLB）
// ------------------------------------------------------------------
describe('审计回归：STEP 全命令走 Tier1', () => {
	it.runIf(TIER1())(
		'simplify --ratio 0.5 → exit 0，面数下降',
		() => {
			const dir = freshDir('audit-step-simplify');
			const r = cli(['simplify', FIX('step/cube.step'), '--ratio', '0.5', '-o', path.join(dir, 'o.glb'), '--json']);
			expect(r.code).toBe(0);
			expect(r.manifest?.tool?.tier).toBe('python-uv');
			expect(r.manifest?.input?.faces).toBeGreaterThan(0);
			expect(r.manifest?.output?.faces ?? 0).toBeGreaterThan(0);
			expect(r.manifest!.output!.faces).toBeLessThan(r.manifest!.input!.faces);
		},
		180_000,
	);

	it.runIf(TIER1())(
		'segment --mode connected → exit 0',
		() => {
			const dir = freshDir('audit-step-segment');
			const r = cli(['segment', FIX('step/assembly.step'), '--mode', 'connected', '-o', dir, '--json']);
			expect(r.code).toBe(0);
			const files = (r.manifest?.output?.files ?? []) as { path: string }[];
			expect(files.length).toBeGreaterThanOrEqual(1);
			for (const f of files) {
				expect(f.path.endsWith('.glb')).toBe(true);
				expect(fs.existsSync(f.path)).toBe(true);
			}
		},
		180_000,
	);

	it.runIf(TIER1())(
		'texture --map box（无 --image）→ exit 0',
		() => {
			const dir = freshDir('audit-step-texture');
			const r = cli(['texture', FIX('step/cube.step'), '--map', 'box', '-o', path.join(dir, 'o.glb'), '--json']);
			expect(r.code).toBe(0);
		},
		180_000,
	);

	it.runIf(TIER1())(
		'optimize --ratio 0.5 → exit 0',
		() => {
			const dir = freshDir('audit-step-optimize');
			const r = cli(['optimize', FIX('step/cube.step'), '--ratio', '0.5', '-o', path.join(dir, 'o.glb'), '--json']);
			expect(r.code).toBe(0);
		},
		180_000,
	);

	it.runIf(TIER1())(
		'lod → exit 0，level-0 是真 GLB 而非 STEP 字节拷贝',
		() => {
			const dir = freshDir('audit-step-lod');
			const r = cli(['lod', FIX('step/cube.step'), '--levels', '2', '-o', dir, '--json']);
			expect(r.code).toBe(0);
			const part0 = path.join(dir, 'part_000.glb');
			expect(fs.existsSync(part0)).toBe(true);
			const magic = fs.readFileSync(part0).subarray(0, 4).toString('ascii');
			expect(magic).toBe('glTF'); // 修复前是原始 STEP 文本字节
		},
		180_000,
	);
});

// ------------------------------------------------------------------
// 审计 #9（部分）：kernel-ts 披露类缺陷（函数级）
// ------------------------------------------------------------------
describe('审计回归：kernel-ts 披露', () => {
	it('simplify --merge：同材质子网格顶点属性不兼容 → MERGE_INCOMPATIBLE_FALLBACK，几何保留（曾静默回退无披露）', async () => {
		const doc = new Document();
		const mat = doc.createMaterial('same');
		const mk = (withUv: boolean, tag: string) => {
			const pos = doc.createAccessor()
				.setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0.5, 0.5]))
				.setType('VEC3');
			const idx = doc.createAccessor()
				.setArray(new Uint32Array([0, 1, 2, 0, 2, 3]))
				.setType('SCALAR');
			const prim = doc.createPrimitive().setAttribute('POSITION', pos).setIndices(idx);
			if (withUv) {
				prim.setAttribute('TEXCOORD_0', doc.createAccessor()
					.setArray(new Float32Array([0, 0, 1, 0, 0, 1, 0.5, 0.5]))
					.setType('VEC2'));
			}
			prim.setMaterial(mat);
			const mesh = doc.createMesh(`mesh_${tag}`).addPrimitive(prim);
			return doc.createNode(`node_${tag}`).setMesh(mesh);
		};
		const scene = doc.createScene('scene');
		scene.addChild(mk(true, 'a')); // 有 UV
		scene.addChild(mk(false, 'b')); // 无 UV → joinPrimitives 不兼容

		const r = await simplifyDocument(doc, { perMesh: false, ratio: 1, minFaces: 1 });
		const codes = r.warnings.map((w) => w.code);
		expect(codes).toContain('MERGE_INCOMPATIBLE_FALLBACK');
		// 几何不受影响：合并失败回退，4 个面（2×2）全保留
		expect(r.facesBefore).toBe(4);
		expect(r.facesAfter).toBe(4);
	});

	it('OBJ 面引用越界 → INDEX_OUT_OF_RANGE + 原点兜底不崩（曾静默 (0,0,0)）', () => {
		const text = [
			'v 0 0 0', 'v 1 0 0', 'v 0 1 0', 'v 0 0 1',
			'vt 0 0',
			'f 1/1 2/1 3/1', // 正常
			'f 1 2 99',      // 顶点越界（只有 4 个顶点）
			'f 4/9 1 2',     // UV 越界（只有 1 个 vt）
		].join('\n');
		const r = objToDocument(text, null, new Map());
		const codes = r.warnings.map((w) => w.code);
		expect(codes).toContain('INDEX_OUT_OF_RANGE');
		let faces = 0;
		for (const mesh of r.doc.getRoot().listMeshes()) {
			for (const prim of mesh.listPrimitives()) {
				faces += (prim.getIndices()?.getArray()?.length ?? 0) / 3;
			}
		}
		expect(faces).toBe(3); // 越界兜底：面仍产出，不丢不崩
	});

	it('CLI 路径不丢弃 loader 警告：simplify 越界 OBJ → INDEX_OUT_OF_RANGE 进 manifest', () => {
		const dir = freshDir('audit-obj-warn');
		fs.writeFileSync(path.join(dir, 'bad.obj'), 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 99\n');
		const r = cli(['simplify', path.join(dir, 'bad.obj'), '--ratio', '0.5', '-o', path.join(dir, 'o.glb'), '--json']);
		expect(r.code).toBe(0);
		expect((r.manifest?.warnings ?? []).map((w: any) => w.code)).toContain('INDEX_OUT_OF_RANGE');
	});

	it.each([
		['ts', []],
		['py', ['--tier', 'py']],
	] as const)('空 OBJ（0 顶点，合法文本）→ exit 6（%s 路径统一空场景口径）', (_tier, extra) => {
		const dir = freshDir('audit-empty-obj');
		fs.writeFileSync(path.join(dir, 'empty.obj'), '# empty obj\n');
		const r = cli(['simplify', path.join(dir, 'empty.obj'), '--ratio', '0.5', ...extra, '-o', path.join(dir, 'o.glb'), '--json']);
		expect(r.code).toBe(6);
	}, 180_000);
});

// ------------------------------------------------------------------
// 审计 #10：fixtures PNG 编码器 RGB 步长 bug（贴图截断 → PIL 拒读、py texture 全挂）
// ------------------------------------------------------------------
describe('审计回归：fixtures 贴图完整性', () => {
	it('multimat/dense 内嵌 PNG 解压数据覆盖全部扫描行', async () => {
		const io = new NodeIO();
		for (const file of ['glb/multimat.glb', 'glb/dense.glb']) {
			const doc = await io.read(FIX(file));
			const textures = doc.getRoot().listTextures();
			expect(textures.length).toBeGreaterThanOrEqual(1);
			for (const tex of textures) {
				const image = tex.getImage();
				expect(image).not.toBeNull();
				const buf = Buffer.from(image!);
				// 解析 PNG chunk：IHDR 宽高 + IDAT 全量 inflate == h*(1+w*4)（RGBA8、filter 字节）
				expect(buf.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
				let pos = 8;
				let w = 0;
				let h = 0;
				const idats: Buffer[] = [];
				while (pos + 12 <= buf.length) {
					const len = buf.readUInt32BE(pos);
					const type = buf.toString('ascii', pos + 4, pos + 8);
					if (type === 'IHDR') {
						w = buf.readUInt32BE(pos + 8);
						h = buf.readUInt32BE(pos + 12);
					} else if (type === 'IDAT') {
						idats.push(buf.subarray(pos + 8, pos + 8 + len));
					}
					pos += 12 + len;
				}
				const raw = zlib.inflateSync(Buffer.concat(idats));
				expect(raw.length).toBe(h * (1 + w * 4)); // 修复前只有约 3/4
			}
		}
	});
});
