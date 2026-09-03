import { z } from 'zod';
import { WARNING_CODES } from './warnings.js';

/**
 * manifest JSON Schema 双实现：
 * - TS 侧：本文件导出的 zod schema（运行时校验）
 * - 交叉校验：导出的 JSON Schema 字符串供 ajv / Python 侧 pydantic 对照
 * 两份定义由 tests/ts/contract.test.ts 强制保持一致（同一样本双向校验）。
 */

export const meshSummaryZ = z.object({
	name: z.string(),
	vertices: z.number().int().nonnegative(),
	faces: z.number().int().nonnegative(),
	material: z.string().nullable(),
	has_uv: z.boolean(),
	has_normals: z.boolean(),
	skipped: z.boolean().optional(),
}).strict();

export const textureSummaryZ = z.object({
	uri: z.string(),
	mime: z.string().nullable(),
	bytes: z.number().int().nonnegative(),
	resolution: z.string().nullable(),
}).strict();

export const inputInfoZ = z.object({
	path: z.string(),
	format: z.string(),
	bytes: z.number().int().nonnegative(),
	vertices: z.number().int().nonnegative(),
	faces: z.number().int().nonnegative(),
	meshes: z.array(meshSummaryZ),
	materials: z.number().int().nonnegative(),
	textures: z.array(textureSummaryZ),
	bbox: z.tuple([z.array(z.number()), z.array(z.number())]).nullable(),
	has_animation: z.boolean(),
}).strict();

export const fileInfoZ = z.object({
	path: z.string(),
	bytes: z.number().int().nonnegative(),
	role: z.enum(['asset', 'preview', 'report', 'part', 'lod']),
}).strict();

export const outputInfoZ = z.object({
	path: z.string(),
	format: z.string(),
	bytes: z.number().int().nonnegative(),
	vertices: z.number().int().nonnegative(),
	faces: z.number().int().nonnegative(),
	files: z.array(fileInfoZ),
}).strict();

export const reportWarningZ = z.object({
	code: z.enum(WARNING_CODES),
	message: z.string(),
	mesh: z.string().optional(),
}).strict();

export const partSummaryZ = z.object({
	index: z.number().int().nonnegative(),
	path: z.string(),
	vertices: z.number().int().nonnegative(),
	faces: z.number().int().nonnegative(),
}).strict();

export const lodLevelSummaryZ = z.object({
	level: z.number().int().nonnegative(),
	path: z.string(),
	faces: z.number().int().nonnegative(),
	vertices: z.number().int().nonnegative(),
	bytes: z.number().int().nonnegative(),
	ratio: z.number(),
}).strict();

export const metricsZ = z.object({
	face_reduction: z.number().optional(),
	byte_reduction: z.number().optional(),
	ratio_actual: z.number().optional(),
	max_error_normalized: z.number().optional(),
	duration_ms: z.number().nonnegative(),
	derives_from: z.string().optional(),
	parts: z.array(partSummaryZ).optional(),
	lod_levels: z.array(lodLevelSummaryZ).optional(),
	tier_note: z.string().optional(),
}).strict();

export const meshifyReportZ = z.object({
	schema: z.literal('meshify.report/v1'),
	tool: z.object({
		name: z.string(),
		version: z.string(),
		tier: z.enum(['ts-wasm', 'python-uv']),
	}),
	command: z.string(),
	input: inputInfoZ,
	output: outputInfoZ.nullable(),
	params: z.record(z.unknown()),
	metrics: metricsZ,
	warnings: z.array(reportWarningZ),
	errors: z.array(z.string()),
	exit_code: z.number().int(),
}).strict();

export type MeshifyReportZ = z.infer<typeof meshifyReportZ>;

export function validateReport(data: unknown): { ok: true; report: MeshifyReportZ } | { ok: false; errors: z.ZodError } {
	const parsed = meshifyReportZ.safeParse(data);
	return parsed.success ? { ok: true, report: parsed.data } : { ok: false, errors: parsed.error };
}

/**
 * JSON Schema（draft-07）——与上方 zod 定义手工保持一致。
 * 供 ajv 交叉校验与 kernel-py 的 pydantic 模型对照（docs 里注明以本文件为准）。
 */
export const MESHIFY_REPORT_JSON_SCHEMA: Record<string, unknown> = {
	$schema: 'http://json-schema.org/draft-07/schema#',
	$sid: 'https://meshify.dev/schemas/report.v1.json',
	title: 'MeshifyReport',
	type: 'object',
	additionalProperties: false,
	required: ['schema', 'tool', 'command', 'input', 'output', 'params', 'metrics', 'warnings', 'errors', 'exit_code'],
	properties: {
		schema: { const: 'meshify.report/v1' },
		tool: {
			type: 'object',
			additionalProperties: false,
			required: ['name', 'version', 'tier'],
			properties: {
				name: { type: 'string' },
				version: { type: 'string' },
				tier: { enum: ['ts-wasm', 'python-uv'] },
			},
		},
		command: { type: 'string' },
		input: { $ref: '#/definitions/inputInfo' },
		output: { anyOf: [{ $ref: '#/definitions/outputInfo' }, { type: 'null' }] },
		params: { type: 'object' },
		metrics: { $ref: '#/definitions/metrics' },
		warnings: { type: 'array', items: { $ref: '#/definitions/warning' } },
		errors: { type: 'array', items: { type: 'string' } },
		exit_code: { type: 'integer' },
	},
	definitions: {
		meshSummary: {
			type: 'object',
			additionalProperties: false,
			required: ['name', 'vertices', 'faces', 'material', 'has_uv', 'has_normals'],
			properties: {
				name: { type: 'string' },
				vertices: { type: 'integer', minimum: 0 },
				faces: { type: 'integer', minimum: 0 },
				material: { type: ['string', 'null'] },
				has_uv: { type: 'boolean' },
				has_normals: { type: 'boolean' },
				skipped: { type: 'boolean' },
			},
		},
		textureSummary: {
			type: 'object',
			additionalProperties: false,
			required: ['uri', 'mime', 'bytes', 'resolution'],
			properties: {
				uri: { type: 'string' },
				mime: { type: ['string', 'null'] },
				bytes: { type: 'integer', minimum: 0 },
				resolution: { type: ['string', 'null'] },
			},
		},
		inputInfo: {
			type: 'object',
			additionalProperties: false,
			required: [
				'path', 'format', 'bytes', 'vertices', 'faces',
				'meshes', 'materials', 'textures', 'bbox', 'has_animation',
			],
			properties: {
				path: { type: 'string' },
				format: { type: 'string' },
				bytes: { type: 'integer', minimum: 0 },
				vertices: { type: 'integer', minimum: 0 },
				faces: { type: 'integer', minimum: 0 },
				meshes: { type: 'array', items: { $ref: '#/definitions/meshSummary' } },
				materials: { type: 'integer', minimum: 0 },
				textures: { type: 'array', items: { $ref: '#/definitions/textureSummary' } },
				bbox: {
					anyOf: [
						{
							type: 'array',
							minItems: 2,
							maxItems: 2,
							items: { type: 'array', items: { type: 'number' } },
						},
						{ type: 'null' },
					],
				},
				has_animation: { type: 'boolean' },
			},
		},
		fileInfo: {
			type: 'object',
			additionalProperties: false,
			required: ['path', 'bytes', 'role'],
			properties: {
				path: { type: 'string' },
				bytes: { type: 'integer', minimum: 0 },
				role: { enum: ['asset', 'preview', 'report', 'part', 'lod'] },
			},
		},
		outputInfo: {
			type: 'object',
			additionalProperties: false,
			required: ['path', 'format', 'bytes', 'vertices', 'faces', 'files'],
			properties: {
				path: { type: 'string' },
				format: { type: 'string' },
				bytes: { type: 'integer', minimum: 0 },
				vertices: { type: 'integer', minimum: 0 },
				faces: { type: 'integer', minimum: 0 },
				files: { type: 'array', items: { $ref: '#/definitions/fileInfo' } },
			},
		},
		warning: {
			type: 'object',
			additionalProperties: false,
			required: ['code', 'message'],
			properties: {
				code: {
					enum: [...WARNING_CODES],
				},
				message: { type: 'string' },
				mesh: { type: 'string' },
			},
		},
		partSummary: {
			type: 'object',
			additionalProperties: false,
			required: ['index', 'path', 'vertices', 'faces'],
			properties: {
				index: { type: 'integer', minimum: 0 },
				path: { type: 'string' },
				vertices: { type: 'integer', minimum: 0 },
				faces: { type: 'integer', minimum: 0 },
			},
		},
		lodLevelSummary: {
			type: 'object',
			additionalProperties: false,
			required: ['level', 'path', 'faces', 'vertices', 'bytes', 'ratio'],
			properties: {
				level: { type: 'integer', minimum: 0 },
				path: { type: 'string' },
				faces: { type: 'integer', minimum: 0 },
				vertices: { type: 'integer', minimum: 0 },
				bytes: { type: 'integer', minimum: 0 },
				ratio: { type: 'number' },
			},
		},
		metrics: {
			type: 'object',
			additionalProperties: false,
			required: ['duration_ms'],
			properties: {
				face_reduction: { type: 'number' },
				byte_reduction: { type: 'number' },
				ratio_actual: { type: 'number' },
				max_error_normalized: { type: 'number' },
				duration_ms: { type: 'number', minimum: 0 },
				derives_from: { type: 'string' },
				parts: { type: 'array', items: { $ref: '#/definitions/partSummary' } },
				lod_levels: { type: 'array', items: { $ref: '#/definitions/lodLevelSummary' } },
				tier_note: { type: 'string' },
			},
		},
	},
};
