import type { ReportWarning } from './warnings.js';
import type { Tier } from './tier-orchestrator.js';

/** 子网格摘要（inspect / 输入侧 / 输出侧共用） */
export interface MeshSummary {
	name: string;
	vertices: number;
	faces: number;
	material: string | null;
	has_uv: boolean;
	has_normals: boolean;
	/** 该子网格被命令跳过（如 < min-faces） */
	skipped?: boolean;
}

export interface TextureSummary {
	uri: string;
	mime: string | null;
	bytes: number;
	resolution: string | null;
}

export type BBox = [number[], number[]];

export interface InputInfo {
	path: string;
	format: string;
	bytes: number;
	vertices: number;
	faces: number;
	meshes: MeshSummary[];
	materials: number;
	textures: TextureSummary[];
	bbox: BBox | null;
	/** 输入含动画/蒙皮/morph（Tier1 路线会丢失，Tier0 结构性保留） */
	has_animation: boolean;
}

export interface OutputInfo {
	path: string;
	format: string;
	bytes: number;
	vertices: number;
	faces: number;
	files: FileInfo[];
}

export interface FileInfo {
	path: string;
	bytes: number;
	role: 'asset' | 'preview' | 'report' | 'part' | 'lod';
}

export interface PartSummary {
	index: number;
	path: string;
	vertices: number;
	faces: number;
}

export interface LodLevelSummary {
	level: number;
	path: string;
	faces: number;
	vertices: number;
	bytes: number;
	ratio: number;
}

export interface Metrics {
	face_reduction?: number;
	byte_reduction?: number;
	ratio_actual?: number;
	/** 归一化几何偏差上界（meshopt error 语义） */
	max_error_normalized?: number;
	duration_ms: number;
	derives_from?: string;
	parts?: PartSummary[];
	lod_levels?: LodLevelSummary[];
	/** Tier 环境快照（doctor 决策依据，便于追溯） */
	tier_note?: string;
}

/** meshify.report/v1 —— CLI 与 Agent 之间最重要的契约 */
export interface MeshifyReport {
	schema: 'meshify.report/v1';
	tool: {
		name: string;
		version: string;
		tier: Tier;
	};
	command: string;
	input: InputInfo;
	output: OutputInfo | null;
	params: Record<string, unknown>;
	metrics: Metrics;
	warnings: ReportWarning[];
	errors: string[];
	exit_code: number;
}

/** 各命令参数模型（CLI 层组装，原样回显进 manifest.params） */
export interface SimplifyParams {
	ratio?: number;
	target_faces?: number;
	error?: number;
	aggressiveness?: number;
	keep_border?: boolean;
	per_mesh?: boolean;
	min_faces?: number;
}

export interface SegmentParams {
	mode: 'semantic' | 'plane' | 'connected';
	clusters?: number;
	axis?: 'x' | 'y' | 'z';
	position?: number;
	origin?: [number, number, number];
	normal?: [number, number, number];
	cap?: boolean;
	min_faces?: number;
}

export interface TextureParams {
	image: string;
	map: 'uv' | 'box' | 'planar' | 'cylindrical' | 'spherical';
	channel?: 'baseColor';
	metallic?: number;
	roughness?: number;
}

export interface ConvertParams {
	to: 'glb' | 'gltf' | 'obj' | 'stl' | 'ply';
}

export interface LodParams {
	levels: number;
	ratio: number;
	error?: number;
	min_faces?: number;
}

export interface OptimizeParams {
	ratio?: number;
	error?: number;
	compression?: 'meshopt' | 'draco' | 'none';
	texture_format?: 'webp' | 'none';
	texture_quality?: number;
	max_texture_size?: number;
	min_faces?: number;
}

export const TOOL_NAME = 'meshify';
export const TOOL_VERSION = '0.1.0';
export const REPORT_SCHEMA = 'meshify.report/v1';
