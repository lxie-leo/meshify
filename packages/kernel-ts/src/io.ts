import { Document, Logger, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';

/**
 * gltf-transform NodeIO 封装。
 * - 注册 ALL_EXTENSIONS（读 side 兼容所有 Khronos 扩展）
 * - meshopt decoder/encoder 按需就绪（读写 EXT_meshopt_compression）
 * - draco3dgltf 为 optionalDependencies：可用时注册 decoder/encoder，
 *   不可用时 Draco 读写均显式报错（doctor 会披露）
 *
 * 注意：OBJ/STL/PLY 不在 gltf-transform 支持范围内（实测 4.5），
 * 由本包 mesh-readers.ts / mesh-writers.ts 自研实现。
 */

/**
 * 新建静默 Document。prune/dedup 等 transform 经 doc.getLogger() 打进度日志
 * （console.info → stdout），而 stdout 是 --json manifest 的契约通道——所有
 * 自建 Document（OBJ/STL/PLY 读取器、部件输出文档）必须压到 WARN 以下，
 * 否则 optimize 的 manifest 前会混入 "prune: Removed types..." 污染解析。
 */
export function createQuietDocument(): Document {
	return new Document().setLogger(new Logger(Logger.Verbosity.WARN));
}

let ioPromise: Promise<NodeIO> | null = null;

export async function createIO(): Promise<NodeIO> {
	if (!ioPromise) {
		const init = (async () => {
			await MeshoptDecoder.ready;
			await MeshoptEncoder.ready;
			// stdout 是 --json manifest 的契约通道：库级 info 日志（prune/dedup 等
			// transform 的进度输出走 console.info → stdout）必须压到 WARN 以下，
			// 否则 optimize 的 manifest 前会混入 "prune: Removed types..." 污染解析
			const io = new NodeIO()
				.setLogger(new Logger(Logger.Verbosity.WARN))
				.registerExtensions(ALL_EXTENSIONS);
			io.registerDependencies({
				'meshopt.decoder': MeshoptDecoder,
				'meshopt.encoder': MeshoptEncoder,
			});
			// Draco 为可选依赖：尽力注册，失败不致命
			try {
				const mod = (await import('draco3dgltf')) as unknown as {
					createDecoderModule: () => Promise<unknown>;
					createEncoderModule: () => Promise<unknown>;
				};
				const [decoder, encoder] = await Promise.all([mod.createDecoderModule(), mod.createEncoderModule()]);
				io.registerDependencies({ 'draco3d.decoder': decoder, 'draco3d.encoder': encoder });
			} catch {
				// draco3dgltf 未安装：Draco 压缩不可用（optimize --compression draco 会显式失败）
			}
			return io;
		})();
		// 初始化失败不缓存 rejected promise：下次调用重新初始化（否则一次瞬态失败永久驻留）
		init.catch(() => {
			if (ioPromise === init) ioPromise = null;
		});
		ioPromise = init;
	}
	return ioPromise;
}

export async function readDocument(path: string): Promise<Document> {
	const io = await createIO();
	return io.read(path);
}

export async function writeDocument(doc: Document, path: string): Promise<void> {
	const io = await createIO();
	await io.write(path, doc);
}

export async function isDracoAvailable(): Promise<boolean> {
	try {
		await import('draco3dgltf');
		return true;
	} catch {
		return false;
	}
}

export interface Tier0SelfCheck {
	/** meshoptimizer WASM 简化器就绪 */
	meshoptWasm: boolean;
	/** sharp 图像编解码可用（贴图压缩/分辨率嗅探） */
	sharp: boolean;
	/** earcut 截面三角化可用 */
	earcut: boolean;
	/** draco3dgltf 可选依赖可用 */
	draco: boolean;
	/** 失败详情（排障用） */
	failures: string[];
}

/** Tier0 环境自检（doctor 命令用；CLI 不直接依赖这些包，统一从内核探测）。 */
export async function tier0SelfCheck(): Promise<Tier0SelfCheck> {
	const failures: string[] = [];
	let meshoptWasm = false;
	try {
		await MeshoptDecoder.ready;
		await MeshoptEncoder.ready;
		meshoptWasm = true;
	} catch (err) {
		failures.push(`meshoptimizer WASM: ${err instanceof Error ? err.message : String(err)}`);
	}
	let sharp = false;
	try {
		await import('sharp');
		sharp = true;
	} catch (err) {
		failures.push(`sharp: ${err instanceof Error ? err.message : String(err)}`);
	}
	let earcutOk = false;
	try {
		const mod = await import('earcut');
		const tris = mod.default([0, 0, 1, 0, 1, 1], undefined, 2);
		earcutOk = tris.length === 3;
		if (!earcutOk) failures.push('earcut: 自检三角化结果异常');
	} catch (err) {
		failures.push(`earcut: ${err instanceof Error ? err.message : String(err)}`);
	}
	const draco = await isDracoAvailable();
	return { meshoptWasm, sharp, earcut: earcutOk, draco, failures };
}
