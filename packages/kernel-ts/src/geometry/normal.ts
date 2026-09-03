/** 法线计算（raw 数组）。 */

export function normalize3(out: number[], i: number): void {
	const x = out[i], y = out[i + 1], z = out[i + 2];
	const len = Math.sqrt(x * x + y * y + z * z);
	if (len > 1e-12) {
		out[i] = x / len;
		out[i + 1] = y / len;
		out[i + 2] = z / len;
	}
}

/** 三角形面法线（未归一化叉积即面积加权）。 */
export function faceNormal(
	ax: number, ay: number, az: number,
	bx: number, by: number, bz: number,
	cx: number, cy: number, cz: number,
	out: number[],
): void {
	const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
	const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
	out[0] = e1y * e2z - e1z * e2y;
	out[1] = e1z * e2x - e1x * e2z;
	out[2] = e1x * e2y - e1y * e2x;
}

/** 面法线归一化后写入 out[idx*3..]，退化面（零叉积）保持零向量。 */
export function faceNormalNormalized(
	ax: number, ay: number, az: number,
	bx: number, by: number, bz: number,
	cx: number, cy: number, cz: number,
	out: number[] | Float32Array,
	idx: number,
): void {
	faceNormal(ax, ay, az, bx, by, bz, cx, cy, cz, TMP);
	const len = Math.sqrt(TMP[0] * TMP[0] + TMP[1] * TMP[1] + TMP[2] * TMP[2]);
	if (len > 1e-12) {
		out[idx] = TMP[0] / len;
		out[idx + 1] = TMP[1] / len;
		out[idx + 2] = TMP[2] / len;
	} else {
		out[idx] = out[idx + 1] = out[idx + 2] = 0;
	}
}

const TMP: number[] = [0, 0, 0];
