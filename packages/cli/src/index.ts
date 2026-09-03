#!/usr/bin/env node
import { Command, InvalidArgumentError } from 'commander';
import { MeshifyError, EXIT_CODES, EXIT_INTERNAL, TOOL_VERSION } from '@meshify/core';
import { registerInspect } from './commands/inspect.js';
import { registerSimplify } from './commands/simplify.js';
import { registerSegment } from './commands/segment.js';
import { registerTexture } from './commands/texture.js';
import { registerConvert } from './commands/convert.js';
import { registerLod } from './commands/lod.js';
import { registerOptimize } from './commands/optimize.js';
import { registerDoctor } from './commands/doctor.js';

/**
 * meshify CLI 入口。
 * 退出码契约（Agent 依赖；详见 SKILL.md / references）：
 * 0 成功 | 2 输入不可读 | 3 格式不支持 | 4 参数冲突/拒绝覆盖 | 5 执行器不可用(Tier1)
 * 6 算法失败 | 7 资源超限/部分成功 | 8 内部错误
 */
const EXIT_HINTS: Record<number, string> = {
	[EXIT_CODES.EXIT_INPUT_UNREADABLE]: '检查路径与文件权限；先 meshify inspect 验证可读性',
	[EXIT_CODES.EXIT_FORMAT_UNSUPPORTED]: '支持 glb/gltf/obj/stl/ply（step 需 Tier1）；详见 meshify --help',
	[EXIT_CODES.EXIT_PARAM_CONFLICT]: '参数冲突或输出已存在（覆盖需显式 --overwrite）；meshify <命令> --help 查看参数',
	[EXIT_CODES.EXIT_EXECUTOR_UNAVAILABLE]: 'Tier1 (Python/uv) 未就绪；meshify doctor 查看环境与安装指引',
	[EXIT_CODES.EXIT_ALGORITHM_FAILED]: '几何算法在当前输入上失败；尝试调整参数或先 segment 拆件',
	[EXIT_CODES.EXIT_RESOURCE_LIMIT]: '资源超限；--force 一次性处理，或先 segment connected 拆件分批',
	[EXIT_CODES.EXIT_INTERNAL]: '内部错误（manifest 已尽可能写出）；请附带 report.json 反馈',
};

const program = new Command()
	.name('meshify')
	.version(TOOL_VERSION)
	.description('三维模型轻量化与优化工具链（Agent Skill 内核）：inspect / simplify / segment / texture / convert / lod / optimize / doctor')
	.showSuggestionAfterError()
	.configureOutput({
		writeErr: (str) => process.stderr.write(str),
	})
	// commander 用法错误（未知选项/非法枚举值）统一进退出码 4（参数冲突），
	// 不让契约外的 exit 1 泄漏给 Agent 调用方。help/version 展示走 exit 0。
	.exitOverride((err) => {
		if (/^commander\.(help|version)/.test(err.code ?? '')) process.exit(0);
		process.stderr.write(`参数错误 (exit 4): ${err.message}\n`);
		process.exit(EXIT_CODES.EXIT_PARAM_CONFLICT);
	});

registerInspect(program);
registerSimplify(program);
registerSegment(program);
registerTexture(program);
registerConvert(program);
registerLod(program);
registerOptimize(program);
registerDoctor(program);

program.parseAsync(process.argv).catch((err: unknown) => {
	if (err instanceof InvalidArgumentError) {
		process.stderr.write(`参数错误: ${err.message}\n`);
		process.exit(4);
	}
	if (err instanceof MeshifyError) {
		process.stderr.write(`meshify 错误 (exit ${err.code}): ${err.message}\n`);
		const hint = EXIT_HINTS[err.code];
		if (hint) process.stderr.write(`提示: ${hint}\n`);
		process.exit(err.code);
	}
	const message = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
	process.stderr.write(`meshify 内部错误 (exit ${EXIT_INTERNAL}): ${message}\n`);
	process.exit(EXIT_INTERNAL);
});
