/**
 * 贴图字节工具：MIME 嗅探 + glTF 核心规范规范化（只认 PNG/JPEG）。
 * CLI texture 命令经此入口使用 sharp，避免 CLI 直接依赖 sharp（pnpm 严格依赖隔离）。
 */

export function sniffImageMime(b: Uint8Array): string | null {
	if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
	if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
	if (b.length >= 12 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
	if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
	if (b.length >= 4 && b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp';
	if (b.length >= 4 && b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a) return 'image/tiff';
	return null;
}

export interface NormalizedImage {
	bytes: Uint8Array;
	mime: string;
	/** 非 PNG/JPEG 源被转换过（调用方写 TEXTURE_DOWNSCALED 披露） */
	converted: boolean;
}

/** webp/gif/bmp/tiff → PNG；png/jpeg 原样直通。 */
export async function normalizeImage(bytes: Uint8Array): Promise<NormalizedImage> {
	const mime = sniffImageMime(bytes);
	if (mime === 'image/png' || mime === 'image/jpeg') {
		return { bytes, mime, converted: false };
	}
	const sharp = (await import('sharp')).default;
	const png = new Uint8Array(await sharp(Buffer.from(bytes)).png().toBuffer());
	return { bytes: png, mime: 'image/png', converted: true };
}
