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
	[EXIT_CODES.EXIT_INPUT_UNREADABLE]: 'Check the path and file permissions; verify readability with meshify inspect first',
	[EXIT_CODES.EXIT_FORMAT_UNSUPPORTED]: 'Supported: glb/gltf/obj/stl/ply (step needs Tier1); see meshify --help',
	[EXIT_CODES.EXIT_PARAM_CONFLICT]: 'Parameter conflict or output already exists (overwriting needs an explicit --overwrite); see meshify <command> --help',
	[EXIT_CODES.EXIT_EXECUTOR_UNAVAILABLE]: 'Tier1 (Python/uv) not ready; run meshify doctor for environment status and install guidance',
	[EXIT_CODES.EXIT_ALGORITHM_FAILED]: 'Geometry algorithm failed on this input; adjust parameters or segment first',
	[EXIT_CODES.EXIT_RESOURCE_LIMIT]: 'Resource limit exceeded; use --force for a one-shot run, or segment connected first and work in batches',
	[EXIT_CODES.EXIT_INTERNAL]: 'Internal error (the manifest was written as far as possible); attach report.json to the bug report',
};

const program = new Command()
	.name('meshify')
	.version(TOOL_VERSION)
	.description('3D model optimization toolkit (Agent Skill core): inspect / simplify / segment / texture / convert / lod / optimize / doctor')
	.showSuggestionAfterError()
	.configureOutput({
		writeErr: (str) => process.stderr.write(str),
	})
	// commander 用法错误（未知选项/非法枚举值）统一进退出码 4（参数冲突），
	// 不让契约外的 exit 1 泄漏给 Agent 调用方。help/version 展示走 exit 0。
	.exitOverride((err) => {
		if (/^commander\.(help|version)/.test(err.code ?? '')) process.exit(0);
		process.stderr.write(`Parameter error (exit 4): ${err.message}\n`);
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
		process.stderr.write(`Parameter error: ${err.message}\n`);
		process.exit(4);
	}
	if (err instanceof MeshifyError) {
		process.stderr.write(`meshify error (exit ${err.code}): ${err.message}\n`);
		const hint = EXIT_HINTS[err.code];
		if (hint) process.stderr.write(`Hint: ${hint}\n`);
		process.exit(err.code);
	}
	const message = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
	process.stderr.write(`meshify internal error (exit ${EXIT_INTERNAL}): ${message}\n`);
	process.exit(EXIT_INTERNAL);
});
