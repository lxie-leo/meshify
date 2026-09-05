import type { Document } from '@gltf-transform/core';
import { dedup, draco, meshopt, prune, quantize, textureCompress } from '@gltf-transform/functions';
import { warn, type ReportWarning } from '@meshify/core';
import { MeshoptEncoder } from 'meshoptimizer';
import { collectPrimitives, totalFaces } from './document-utils.js';
import { simplifyDocument } from './simplify.js';

/**
 * 一键优化管线（Tier0）：dedup → prune →（可选简化）→（可选贴图压缩/降采样）
 * →（可选量化）→（可选 meshopt/draco 几何压缩）。
 *
 * - 贴图压缩经 sharp（webp/jpeg/png），超过 --texture-size 自动降采样并写
 *   TEXTURE_DOWNSCALED（坑 11：尺寸换清晰度，显式披露）
 * - draco 依赖可选包 draco3dgltf：未安装时跳过几何压缩 + DRACO_UNAVAILABLE，
 *   其余步骤照常完成（部分成功而非整体失败）
 * - meshopt 自带量化（QuantizeOptions 继承），codec=meshopt 时不重复 quantize()
 * - 简化复用 simplify 内核（含 min-faces 跳过 / 误差上限策略 / 告警语义）
 */

export type OptimizeCodec = 'meshopt' | 'draco' | 'none';
export type OptimizeTextureFormat = 'webp' | 'jpeg' | 'png';

export interface OptimizeKernelOptions {
	ratio?: number;
	error?: number;
	keepBorder?: boolean;
	minFaces?: number;
	textureFormat?: OptimizeTextureFormat | null;
	/** 贴图最长边上限（超出自动降采样） */
	textureSize?: number;
	codec?: OptimizeCodec;
	quantize?: boolean;
}

export interface OptimizeKernelResult {
	warnings: ReportWarning[];
	facesBefore: number;
	facesAfter: number;
	textureCount: number;
	codecApplied: OptimizeCodec;
}

export async function optimizeDocument(
	doc: Document,
	opts: OptimizeKernelOptions & { warnings?: ReportWarning[] } = {},
): Promise<OptimizeKernelResult> {
	const warnings = opts.warnings ?? [];
	const codec = opts.codec ?? 'meshopt';
	const prims = collectPrimitives(doc);
	const facesBefore = totalFaces(prims);
	const textureCount = doc.getRoot().listTextures().length;

	// 1. 去重 + 修剪（重复材质/贴图/访问器、悬空属性）
	await doc.transform(dedup(), prune());

	// 2. 可选简化
	let facesAfter = facesBefore;
	if (opts.ratio !== undefined && opts.ratio < 1) {
		const result = await simplifyDocument(doc, {
			ratio: opts.ratio,
			error: opts.error,
			keepBorder: opts.keepBorder,
			minFaces: opts.minFaces,
			warnings,
		});
		facesAfter = result.facesAfter;
	} else {
		facesAfter = totalFaces(collectPrimitives(doc));
	}

	// 3. 贴图压缩 / 降采样
	if (opts.textureFormat && textureCount > 0) {
		const sharp = (await import('sharp')).default;
		const before = doc.getRoot().listTextures();
		const oversized = await countOversized(before, opts.textureSize ?? Infinity);
		await doc.transform(
			textureCompress({
				encoder: sharp,
				targetFormat: opts.textureFormat,
				resize: opts.textureSize ? [opts.textureSize, opts.textureSize] : undefined,
			}),
		);
		if (oversized > 0) {
			warnings.push(
				warn('TEXTURE_DOWNSCALED', `${oversized} texture(s) exceeded the max edge length ${opts.textureSize} and were downsampled (sharpness traded for size)`),
			);
		}
	}

	// 4. 几何压缩（meshopt 自带量化；draco 依赖可选包；none 时按需显式量化）
	let codecApplied: OptimizeCodec = 'none';
	if (codec === 'meshopt') {
		await MeshoptEncoder.ready;
		await doc.transform(meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
		codecApplied = 'meshopt';
	} else if (codec === 'draco') {
		try {
			const draco3d = (await import('draco3dgltf')).default;
			void draco3d; // 编码器实例由 io 的 registerDependencies 提供，此处仅探测可用性
			await doc.transform(draco());
			codecApplied = 'draco';
		} catch {
			warnings.push(
				warn(
					'DRACO_UNAVAILABLE',
					'draco encoding requested but the optional dependency draco3dgltf is unavailable; geometry compression skipped (other steps proceed)',
				),
			);
		}
	} else if (opts.quantize !== false) {
		await doc.transform(quantize());
	}

	return { warnings, facesBefore, facesAfter, textureCount, codecApplied };
}

async function countOversized(textures: { getImage(): Uint8Array | null }[], maxSize: number): Promise<number> {
	if (!Number.isFinite(maxSize)) return 0;
	const sharp = (await import('sharp')).default;
	let count = 0;
	for (const tex of textures) {
		const image = tex.getImage();
		if (!image) continue;
		try {
			const meta = await sharp(image).metadata();
			if (meta.width && meta.height && Math.max(meta.width, meta.height) > maxSize) count++;
		} catch {
			// 解析失败不计
		}
	}
	return count;
}
