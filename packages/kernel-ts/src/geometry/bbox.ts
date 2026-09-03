/** 包围盒计算（raw Float32Array，stride 3）。 */

export interface BBox3 {
	min: [number, number, number];
	max: [number, number, number];
}

export function computeBBox(positions: Float32Array): BBox3 | null {
	if (positions.length < 3) return null;
	const min: [number, number, number] = [Infinity, Infinity, Infinity];
	const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
	for (let i = 0; i < positions.length; i += 3) {
		const x = positions[i], y = positions[i + 1], z = positions[i + 2];
		if (x < min[0]) min[0] = x;
		if (y < min[1]) min[1] = y;
		if (z < min[2]) min[2] = z;
		if (x > max[0]) max[0] = x;
		if (y > max[1]) max[1] = y;
		if (z > max[2]) max[2] = z;
	}
	return { min, max };
}

export function bboxUnion(a: BBox3 | null, b: BBox3 | null): BBox3 | null {
	if (!a) return b;
	if (!b) return a;
	return {
		min: [Math.min(a.min[0], b.min[0]), Math.min(a.min[1], b.min[1]), Math.min(a.min[2], b.min[2])],
		max: [Math.max(a.max[0], b.max[0]), Math.max(a.max[1], b.max[1]), Math.max(a.max[2], b.max[2])],
	};
}

export function bboxDiagonal(bbox: BBox3): number {
	const dx = bbox.max[0] - bbox.min[0];
	const dy = bbox.max[1] - bbox.min[1];
	const dz = bbox.max[2] - bbox.min[2];
	return Math.sqrt(dx * dx + dy * dy + dz * dz);
}
