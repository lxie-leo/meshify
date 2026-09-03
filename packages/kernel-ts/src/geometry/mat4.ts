/** 最小 mat4 工具（列主序，与 glTF 一致）。仅覆盖内核需要的运算，不引入 three.js。 */

/** 接受 gltf-transform 的 mat4 元组或 Float32Array。 */
export type Mat4Like = ArrayLike<number> & { [i: number]: number };

/** 变换点（含平移）。 */
export function transformPoint(m: Mat4Like, x: number, y: number, z: number, out: number[]): number[] {
	out[0] = m[0] * x + m[4] * y + m[8] * z + m[12];
	out[1] = m[1] * x + m[5] * y + m[9] * z + m[13];
	out[2] = m[2] * x + m[6] * y + m[10] * z + m[14];
	return out;
}

/** 变换方向（不含平移；假定均匀缩放，调用方负责归一化）。 */
export function transformDirection(m: Mat4Like, x: number, y: number, z: number, out: number[]): number[] {
	out[0] = m[0] * x + m[4] * y + m[8] * z;
	out[1] = m[1] * x + m[5] * y + m[9] * z;
	out[2] = m[2] * x + m[6] * y + m[10] * z;
	return out;
}
