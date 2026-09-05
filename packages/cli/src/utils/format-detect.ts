import * as fs from 'node:fs';
import * as path from 'node:path';
import { MeshifyError, EXIT_FORMAT_UNSUPPORTED, EXIT_INPUT_UNREADABLE } from '@meshify/core';
import { detectFormat, type SniffFormat } from '@meshify/kernel-ts';

/** CLI 侧输入格式（= 内核嗅探结果去掉 unknown）。 */
export type InputFormat = Exclude<SniffFormat, 'unknown'>;

const HEADER_BYTES = 8192;

/**
 * 输入格式探测：扩展名优先（内核 detectFormat 的快捷路径），
 * 无扩展名/未知扩展时读头部做内容嗅探；二进制 STL 无扩展名场合需要全文件长度校验。
 */
export function sniffInputFormat(inputPath: string): InputFormat {
	let stat: fs.Stats;
	try {
		stat = fs.statSync(inputPath);
	} catch (err) {
		throw new MeshifyError(
			EXIT_INPUT_UNREADABLE,
			`Input file missing or unreadable: ${inputPath} (${err instanceof Error ? err.message : String(err)})`,
		);
	}
	if (!stat.isFile()) {
		throw new MeshifyError(EXIT_INPUT_UNREADABLE, `Input is not a regular file: ${inputPath}`);
	}

	const hasKnownExt = /\.(glb|gltf|obj|stl|ply|step|stp)$/i.test(inputPath);
	const length = hasKnownExt ? HEADER_BYTES : Math.min(stat.size, 64 * 1024 * 1024);
	const fd = fs.openSync(inputPath, 'r');
	try {
		const buf = Buffer.alloc(Math.max(length, 0));
		const n = fs.readSync(fd, buf, 0, buf.length, 0);
		const fmt = detectFormat(new Uint8Array(buf.subarray(0, n)), inputPath);
		if (fmt === 'unknown') {
			throw new MeshifyError(
				EXIT_FORMAT_UNSUPPORTED,
				`Cannot recognize the input format: ${path.basename(inputPath)}. Supported: GLB / GLTF / OBJ / STL / PLY / STEP(STP).`,
			);
		}
		return fmt;
	} finally {
		fs.closeSync(fd);
	}
}

/** 输出格式合法性（convert --to）。 */
export function assertOutputFormat(to: string): asserts to is 'glb' | 'gltf' | 'obj' | 'stl' | 'ply' {
	if (!['glb', 'gltf', 'obj', 'stl', 'ply'].includes(to)) {
		throw new MeshifyError(
			EXIT_FORMAT_UNSUPPORTED,
			`Unsupported output format: ${to}. Options: glb / gltf / obj / stl / ply.`,
		);
	}
}
