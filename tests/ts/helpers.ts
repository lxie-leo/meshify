/** 测试共享助手：CLI 子进程调用、几何质量度量、fixtures 路径。 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const FIX = (p: string) => path.join(ROOT, 'fixtures', p);
export const CLI = path.join(ROOT, 'packages', 'cli', 'bin', 'meshify.js');
export const WORK = path.join(ROOT, 'tmp', 'vitest-work');

export interface CliResult {
	code: number;
	stdout: string;
	stderr: string;
	/** stdout 中的 manifest JSON（--json 时存在），解析失败为 null */
	manifest: Record<string, any> | null;
}

/** 调 CLI。env 可注入 MESHIFY_TEST_* 开关。 */
export function cli(args: string[], opts: { cwd?: string } = {}): CliResult {
	const r = spawnSync(process.execPath, [CLI, ...args], {
		encoding: 'utf8',
		cwd: opts.cwd ?? ROOT,
		env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
	});
	let manifest: Record<string, any> | null = null;
	const i = r.stdout.indexOf('{');
	if (i >= 0) {
		try {
			manifest = JSON.parse(r.stdout.slice(i));
		} catch { /* 非 JSON 输出 */ }
	}
	const code = r.status ?? -1;
	// exit 8 = 内部错误，永远非预期：把 CLI stderr 直接打到测试日志，CI 上不再盲猜
	if (code === 8 && r.stderr) console.error(`[cli exit 8 stderr] ${r.stderr}`);
	return { code, stdout: r.stdout, stderr: r.stderr, manifest };
}

/** 独立输出目录（每个用例唯一），避免 .meshify/ 布局的覆盖干扰。 */
export function freshDir(name: string): string {
	const d = path.join(WORK, name, `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
	fs.mkdirSync(d, { recursive: true });
	return d;
}

export function fixtureExists(p: string): boolean {
	return fs.existsSync(FIX(p));
}

/** uv 可用性（一致性/契约的 Python 样本测试在无 uv 环境自动 skip）。 */
let uvOk: boolean | null = null;
export function hasUv(): boolean {
	if (uvOk === null) {
		uvOk = spawnSync('uv', ['--version'], { encoding: 'utf8' }).status === 0;
	}
	return uvOk;
}

// ------------------------------------------------------------------
// 几何质量度量（与内核实现无关的独立实现，避免同源错误自证）
// ------------------------------------------------------------------

export interface TriMesh {
	positions: Float32Array; // stride 3
	indices: Uint32Array;    // stride 3
}

/** 点到三角形最短距离（Ericson Real-Time Collision Detection）。 */
export function pointTriangleDistance(p: number[], a: number[], b: number[], c: number[]): number {
	const sub = (u: number[], v: number[]) => [u[0] - v[0], u[1] - v[1], u[2] - v[2]];
	const dot = (u: number[], v: number[]) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
	const cross = (u: number[], v: number[]) => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
	const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a);
	const d1 = dot(ab, ap), d2 = dot(ac, ap);
	if (d1 <= 0 && d2 <= 0) return Math.hypot(...ap);
	const bp = sub(p, b);
	const d3 = dot(ab, bp), d4 = dot(ac, bp);
	if (d3 >= 0 && d4 <= d3) return Math.hypot(...bp);
	const vc = d1 * d4 - d3 * d2;
	if (vc <= 0 && d1 >= 0 && d3 <= 0) {
		const t = d1 / (d1 - d3);
		return Math.hypot(...[a[0] + t * ab[0] - p[0], a[1] + t * ab[1] - p[1], a[2] + t * ab[2] - p[2]]);
	}
	const cp = sub(p, c);
	const d5 = dot(ab, cp), d6 = dot(ac, cp);
	if (d6 >= 0 && d5 <= d6) return Math.hypot(...cp);
	const vb = d5 * d2 - d1 * d6;
	if (vb <= 0 && d2 >= 0 && d6 <= 0) {
		const t = d2 / (d2 - d6);
		return Math.hypot(...[a[0] + t * ac[0] - p[0], a[1] + t * ac[1] - p[1], a[2] + t * ac[2] - p[2]]);
	}
	const va = d3 * d6 - d5 * d4;
	if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
		const t = (d4 - d3) / (d4 - d3 + (d5 - d6));
		const bc = sub(c, b);
		return Math.hypot(...[b[0] + t * bc[0] - p[0], b[1] + t * bc[1] - p[1], b[2] + t * bc[2] - p[2]]);
	}
	const denom = 1 / (va + vb + vc);
	const v = vb * denom, w = vc * denom;
	return Math.hypot(...[a[0] + ab[0] * v + ac[0] * w - p[0], a[1] + ab[1] * v + ac[1] * w - p[1], a[2] + ab[2] * v + ac[2] * w - p[2]]);
}

const v3 = (arr: ArrayLike<number>, i: number) => [arr[3 * i], arr[3 * i + 1], arr[3 * i + 2]];

/** 单向 Hausdorff（采样点 → 目标网格），按对角线归一。网格小时直接全量。 */
export function directedHausdorff(samples: number[][], target: TriMesh): number {
	let worst = 0;
	for (const p of samples) {
		let best = Infinity;
		for (let t = 0; t < target.indices.length; t += 3) {
			best = Math.min(best, pointTriangleDistance(p, v3(target.positions, target.indices[t]), v3(target.positions, target.indices[t + 1]), v3(target.positions, target.indices[t + 2])));
			if (best < worst) break; // 已小于当前最差，剪枝
		}
		worst = Math.max(worst, best);
	}
	return worst;
}

export function meshDiagonal(m: TriMesh): number {
	let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
	for (let i = 0; i < m.positions.length / 3; i++) {
		const p = v3(m.positions, i);
		for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], p[k]); max[k] = Math.max(max[k], p[k]); }
	}
	return Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
}

/** 流形边界边计数：按量化端点统计每条无向边的邻接面数，返回邻接数 ≠ 2 的边数。 */
export function boundaryEdgeCount(m: TriMesh, eps = 1e-5): number {
	const key = (p: number[]) => p.map((x) => Math.round(x / eps)).join(',');
	const vkey: string[] = [];
	for (let i = 0; i < m.positions.length / 3; i++) vkey.push(key(v3(m.positions, i)));
	const count = new Map<string, number>();
	for (let t = 0; t < m.indices.length; t += 3) {
		const tri = [m.indices[t], m.indices[t + 1], m.indices[t + 2]];
		for (let e = 0; e < 3; e++) {
			const a = vkey[tri[e]], b = vkey[tri[(e + 1) % 3]];
			const k = a < b ? `${a}|${b}` : `${b}|${a}`;
			count.set(k, (count.get(k) ?? 0) + 1);
		}
	}
	let boundary = 0;
	for (const n of count.values()) if (n !== 2) boundary++;
	return boundary;
}

/** 从 gltf-transform Document 取首个 mesh 的 TriMesh（世界系烘焙含节点平移）。 */
export async function readTriMesh(glbPath: string, nodeTranslation: number[] = [0, 0, 0]): Promise<TriMesh> {
	const { readDocument } = await import('@meshify/kernel-ts');
	const doc = await readDocument(glbPath);
	const prim = doc.getRoot().listMeshes()[0].listPrimitives()[0];
	const positions = prim.getAttribute('POSITION').getArray() as Float32Array;
	const indices = (prim.getIndices()?.getArray() ?? Uint32Array.from(Array.from({ length: positions.length / 3 }, (_, i) => i))) as Uint32Array;
	const world = new Float32Array(positions.length);
	for (let i = 0; i < positions.length; i += 3) {
		world[i] = positions[i] + nodeTranslation[0];
		world[i + 1] = positions[i + 1] + nodeTranslation[1];
		world[i + 2] = positions[i + 2] + nodeTranslation[2];
	}
	return { positions: world, indices };
}
