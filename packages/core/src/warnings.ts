/**
 * 警告码契约（对齐 plan §3.3；来源为 maestro 12 实坑资产的「默认行为 + 警告码」内嵌）。
 *
 * 规则：所有降级/近似/跳过必须显式写进 manifest 的 warnings，绝不信默降级。
 */
export const WARNING_CODES = [
	/** 坑 12：子网格面数 < min-faces，跳过简化原样保留 */
	'SMALL_MESH_SKIPPED',
	/** 无 UV 源可重映射，材质降级为仅 baseColor 标量（贴图被剥离） */
	'MATERIAL_DEGRADED_TO_BASE_COLOR',
	/** 贴图按最近邻/子集保留近似处理，极端形变区可能拉伸 */
	'UV_REMAP_APPROXIMATED',
	/** 输入疑似非流形/退化几何，结果质量可能受损 */
	'NON_MANIFOLD_INPUT',
	/** 坑 6：切割/封口产生的零面积碎片三角形原样保留（渲染不可见，删除会开洞） */
	'FRAGMENT_FACES_KEPT',
	/** 坑 3：产物材质强制 doubleSided（开口壳防背面剔除） */
	'DOUBLE_SIDED_FORCED',
	/** 坑 11 相关：纹理被降采样（超过 max-texture-size） */
	'TEXTURE_DOWNSCALED',
	/** 非 PNG/JPEG 贴图被规范化转 PNG（glTF 核心规范只内建这两种位图格式） */
	'TEXTURE_FORMAT_CONVERTED',
	/** Tier1 不可用，已显式降级到 Tier0 执行 */
	'TIER_DOWNGRADED',
	/** 输入含 skin/蒙皮/动画/morph，已自动改走 Tier0 以结构性保留动画 */
	'SKIN_ANIMATION_PRESERVED',
	/** 坑 2 相关：模型 UV 为合并产生的色块图集，已忽略并自动生成盒式 UV */
	'ATLAS_UV_IGNORED',
	/** 模型无 UV 坐标，已自动生成盒式 UV */
	'AUTO_BOX_UV_GENERATED',
	/** 资源超限：仅部分子网格完成处理（部分成功 manifest，exit 7） */
	'PARTIAL_SUCCESS',
	/** OBJ→GLB 时检测到多个等价材质，已自动合并 */
	'MATERIALS_MERGED',
	/** --merge 请求的合并因子网格属性不兼容未能执行，已回退逐子网格处理（几何/材质不受影响） */
	'MERGE_INCOMPATIBLE_FALLBACK',
	/** OBJ 面引用了不存在的顶点/UV/法线索引，越界分量已按默认值兜底 */
	'INDEX_OUT_OF_RANGE',
	/** 连通域分割：面数 < min-parts-faces 的碎片部件被丢弃（全部会被丢时保留最大者） */
	'SMALL_PARTS_DROPPED',
	/** 请求 draco 编码但 draco3dgltf 未安装（可选依赖），已跳过几何压缩 */
	'DRACO_UNAVAILABLE',
] as const;

export type WarningCode = (typeof WARNING_CODES)[number];

export interface ReportWarning {
	code: WarningCode;
	message: string;
	/** 可选：关联的子网格名 */
	mesh?: string;
}

export function warn(code: WarningCode, message: string, mesh?: string): ReportWarning {
	return mesh === undefined ? { code, message } : { code, message, mesh };
}

/** 警告收集器：去重（同 code+mesh 只保留首条，消息拼接）。 */
export class WarningCollector {
	readonly items: ReportWarning[] = [];
	private readonly seen = new Set<string>();

	add(w: ReportWarning): void {
		const key = `${w.code}|${w.mesh ?? ''}`;
		if (this.seen.has(key)) return;
		this.seen.add(key);
		this.items.push(w);
	}

	addAll(ws: ReportWarning[]): void {
		for (const w of ws) this.add(w);
	}
}
