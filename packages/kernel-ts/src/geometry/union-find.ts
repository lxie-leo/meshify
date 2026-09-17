/**
 * 并查集：连通域分割、同标签切分这类图算法共用的底层工具。
 * 路径压缩 + 按秩合并，近线性。
 */
export class UnionFind {
	private parent: Int32Array;
	private rank: Uint8Array;

	constructor(n: number) {
		this.parent = new Int32Array(n);
		this.rank = new Uint8Array(n);
		for (let i = 0; i < n; i++) this.parent[i] = i;
	}

	find(x: number): number {
		let root = x;
		while (this.parent[root] !== root) root = this.parent[root];
		// 路径压缩
		while (this.parent[x] !== root) {
			const next = this.parent[x];
			this.parent[x] = root;
			x = next;
		}
		return root;
	}

	union(a: number, b: number): boolean {
		const ra = this.find(a);
		const rb = this.find(b);
		if (ra === rb) return false;
		if (this.rank[ra] < this.rank[rb]) {
			this.parent[ra] = rb;
		} else if (this.rank[ra] > this.rank[rb]) {
			this.parent[rb] = ra;
		} else {
			this.parent[rb] = ra;
			this.rank[ra]++;
		}
		return true;
	}

	connected(a: number, b: number): boolean {
		return this.find(a) === this.find(b);
	}

	/** 紧凑化：返回 compOf 数组（每个元素映射到 0..count-1 的连续部件号）与部件总数。 */
	compact(): { compOf: Int32Array; count: number } {
		const n = this.parent.length;
		const remap = new Map<number, number>();
		const compOf = new Int32Array(n);
		for (let i = 0; i < n; i++) {
			const root = this.find(i);
			let cid = remap.get(root);
			if (cid === undefined) {
				cid = remap.size;
				remap.set(root, cid);
			}
			compOf[i] = cid;
		}
		return { compOf, count: remap.size };
	}
}

/** 位置量化焊接键：坐标乘 1e6 取整（相当于 1e-6 的容差）。STEP 按颜色拆出
 *  的子网格顶点位置一模一样却各算各的，量化后得到同一个键，就能焊上。 */
export function weldKey(x: number, y: number, z: number): string {
	return `${Math.round(x * 1e6)},${Math.round(y * 1e6)},${Math.round(z * 1e6)}`;
}
