import type { Document } from '@gltf-transform/core';
import type { InputInfo, MeshSummary, TextureSummary } from '@meshify/core';
import { collectPrimitives, documentWorldBBox } from './document-utils.js';

/**
 * 模型分析（只读）：格式/顶点面数/子网格/材质/纹理/包围盒/疑似问题。
 * 疑似问题以 hints 形式返回（供 CLI 层转译成 warnings / SKILL.md 决策依据）。
 */

export interface InspectHints {
	/** 有子网格缺少法线（预览/渲染可能偏暗，flatShading 兜底） */
	missingNormals: string[];
	/** 有子网格缺少 UV（texture 命令会自动生成盒式 UV） */
	missingUvs: string[];
	/** 面数低于简化阈值的子网格 */
	smallMeshes: string[];
	/** 非三角 mode 的 primitive（几何命令会跳过它们） */
	nonTrianglePrimitives: string[];
}

export interface InspectResult {
	meshes: MeshSummary[];
	vertices: number;
	faces: number;
	materials: number;
	textures: TextureSummary[];
	bbox: InputInfo['bbox'];
	hasAnimation: boolean;
	hints: InspectHints;
}

export async function inspectDocument(doc: Document): Promise<InspectResult> {
	const prims = collectPrimitives(doc);
	const meshes: MeshSummary[] = [];
	const hints: InspectHints = {
		missingNormals: [],
		missingUvs: [],
		smallMeshes: [],
		nonTrianglePrimitives: [],
	};
	let vertices = 0;
	let faces = 0;
	for (const p of prims) {
		const v = p.localPositions.length / 3;
		const f = p.indices.length / 3;
		vertices += v;
		faces += f;
		meshes.push({
			name: p.name,
			vertices: v,
			faces: f,
			material: p.material ? p.material.getName() || '(unnamed)' : null,
			has_uv: !!p.localUvs,
			has_normals: !!p.localNormals,
		});
		if (!p.localNormals) hints.missingNormals.push(p.name);
		if (!p.localUvs) hints.missingUvs.push(p.name);
		if (f > 0 && f < 200) hints.smallMeshes.push(`${p.name}(${f})`);
	}

	// 非三角 primitive 检测（独立于 collectPrimitives 的 TRIANGLES 过滤）
	for (const mesh of doc.getRoot().listMeshes()) {
		for (const prim of mesh.listPrimitives()) {
			if ((prim.getMode() ?? 4) !== 4) hints.nonTrianglePrimitives.push(mesh.getName() || '(unnamed)');
		}
	}

	// 纹理统计（分辨率经 sharp metadata）
	const textures: TextureSummary[] = [];
	const sharp = await import('sharp');
	for (const tex of doc.getRoot().listTextures()) {
		const image = tex.getImage();
		const bytes = image ? image.byteLength : 0;
		let resolution: string | null = null;
		if (image) {
			try {
				const meta = await sharp.default(image).metadata();
				if (meta.width && meta.height) resolution = `${meta.width}x${meta.height}`;
			} catch {
				// 个别格式解析失败不致命
			}
		}
		textures.push({
			uri: tex.getURI() || tex.getName() || `texture_${textures.length}`,
			mime: tex.getMimeType(),
			bytes,
			resolution,
		});
	}

	const bbox = documentWorldBBox(prims);
	const root = doc.getRoot();
	const hasAnimation = root.listAnimations().length > 0 || root.listSkins().length > 0;

	return {
		meshes,
		vertices,
		faces,
		materials: root.listMaterials().length,
		textures,
		bbox: bbox ? [bbox.min, bbox.max] : null,
		hasAnimation,
		hints,
	};
}

/** 由文件路径 + inspect 结果组装 InputInfo。 */
export function toInputInfo(path: string, format: string, bytes: number, result: InspectResult): InputInfo {
	return {
		path,
		format,
		bytes,
		vertices: result.vertices,
		faces: result.faces,
		meshes: result.meshes,
		materials: result.materials,
		textures: result.textures,
		bbox: result.bbox,
		has_animation: result.hasAnimation,
	};
}
