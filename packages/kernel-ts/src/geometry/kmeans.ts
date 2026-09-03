/** 轻量 KMeans（法线+位置联合聚类用，对齐 maestro sklearn KMeans 语义：kmeans++ 初始化 + 固定种子）。 */

/** 确定性 PRNG（mulberry32），对齐 sklearn random_state=42 的「可复现」语义。 */
export function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export interface KMeansResult {
	/** k*d 质心 */
	centroids: Float64Array;
	/** 每个样本的簇标签（全量样本，非仅采样集） */
	labels: Int32Array;
	k: number;
	iterations: number;
}

export interface KMeansOptions {
	k: number;
	seed?: number;
	maxIterations?: number;
	/** 采样训练（大网格加速，对齐 maestro n_clusters*100 采样）；标签仍对全量预测 */
	sampleLimit?: number;
}

export function kmeans(data: Float64Array, n: number, d: number, opts: KMeansOptions): KMeansResult {
	const k = Math.max(1, Math.min(opts.k, n));
	const rng = mulberry32(opts.seed ?? 42);
	const maxIter = opts.maxIterations ?? 50;

	// 采样训练集（确定性：等距 + 偏移采样，避免随机采样对少量簇的不稳定）
	let trainIdx: Int32Array;
	const limit = opts.sampleLimit && opts.sampleLimit > 0 ? Math.min(opts.sampleLimit, n) : n;
	if (limit < n) {
		trainIdx = new Int32Array(limit);
		for (let i = 0; i < limit; i++) trainIdx[i] = Math.floor((i * n) / limit);
	} else {
		trainIdx = new Int32Array(n);
		for (let i = 0; i < n; i++) trainIdx[i] = i;
	}

	// ---- kmeans++ 初始化 ----
	const centroids = new Float64Array(k * d);
	const first = trainIdx[Math.floor(rng() * trainIdx.length)];
	for (let j = 0; j < d; j++) centroids[j] = data[first * d + j];

	const dist2 = new Float64Array(trainIdx.length).fill(Infinity);
	const updateDist = (c: number) => {
		for (let i = 0; i < trainIdx.length; i++) {
			const si = trainIdx[i] * d;
			let s = 0;
			for (let j = 0; j < d; j++) {
				const diff = data[si + j] - centroids[c * d + j];
				s += diff * diff;
			}
			if (s < dist2[i]) dist2[i] = s;
		}
	};
	updateDist(0);
	for (let c = 1; c < k; c++) {
		let total = 0;
		for (let i = 0; i < dist2.length; i++) total += dist2[i];
		if (total <= 1e-12) {
			// 全部重合：复制首个样本
			const si = trainIdx[0] * d;
			for (let j = 0; j < d; j++) centroids[c * d + j] = data[si + j];
			continue;
		}
		let target = rng() * total;
		let pick = 0;
		for (; pick < dist2.length - 1; pick++) {
			target -= dist2[pick];
			if (target <= 0) break;
		}
		const si = trainIdx[pick] * d;
		for (let j = 0; j < d; j++) centroids[c * d + j] = data[si + j];
		updateDist(c);
	}

	// ---- Lloyd 迭代 ----
	const assign = new Int32Array(trainIdx.length);
	let iterations = 0;
	for (; iterations < maxIter; iterations++) {
		let changed = false;
		for (let i = 0; i < trainIdx.length; i++) {
			const si = trainIdx[i] * d;
			let best = 0, bestDist = Infinity;
			for (let c = 0; c < k; c++) {
				let s = 0;
				for (let j = 0; j < d; j++) {
					const diff = data[si + j] - centroids[c * d + j];
					s += diff * diff;
				}
				if (s < bestDist - 1e-12) {
					bestDist = s;
					best = c;
				}
			}
			if (assign[i] !== best) {
				assign[i] = best;
				changed = true;
			}
		}
		// 更新质心
		const sums = new Float64Array(k * d);
		const counts = new Int32Array(k);
		for (let i = 0; i < trainIdx.length; i++) {
			const si = trainIdx[i] * d;
			const c = assign[i];
			counts[c]++;
			for (let j = 0; j < d; j++) sums[c * d + j] += data[si + j];
		}
		for (let c = 0; c < k; c++) {
			if (counts[c] === 0) continue; // 空簇保留原质心
			for (let j = 0; j < d; j++) centroids[c * d + j] = sums[c * d + j] / counts[c];
		}
		if (!changed && iterations > 0) break;
	}

	// ---- 全量样本预测 ----
	const labels = new Int32Array(n);
	for (let i = 0; i < n; i++) {
		let best = 0, bestDist = Infinity;
		for (let c = 0; c < k; c++) {
			let s = 0;
			for (let j = 0; j < d; j++) {
				const diff = data[i * d + j] - centroids[c * d + j];
				s += diff * diff;
			}
			if (s < bestDist - 1e-12) {
				bestDist = s;
				best = c;
			}
		}
		labels[i] = best;
	}

	return { centroids, labels, k, iterations };
}
