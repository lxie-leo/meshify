import type { Command } from 'commander';
import {
	addCommonOptions,
	emitReport,
	loadInput,
	parseTierPref,
	withFailureManifest,
	type GlobalOptions,
} from '../utils/common.js';
import { sniffInputFormat } from '../utils/format-detect.js';
import { routeTier } from '../utils/tier.js';
import { OutputManager } from '../utils/output.js';
import { progress, progressDone } from '../utils/spinner.js';

/** meshify inspect —— 只读分析，永远不写模型产物；manifest 即输出。 */
export function registerInspect(program: Command): void {
	addCommonOptions(
		program
			.command('inspect')
			.description('Analyze a model: format/vertex-face counts/submeshes/materials/textures/bbox/suspected issues (read-only, no artifact file)')
			.argument('<input>', 'input model (glb/gltf/obj/stl/ply; step needs Tier1)'),
		{ noOutput: true },
	).action(withFailureManifest('inspect', 'inspect', async (input: string, cmdOpts: Record<string, unknown>) => {
		const opts = cmdOpts as GlobalOptions;
		const startedAt = Date.now();
		const format = sniffInputFormat(input);
		parseTierPref(opts.tier);

		// STEP 只能经 Tier1 分析（gmsh 网格化）；其余格式 auto 走 Tier0
		const route = await routeTier('inspect', input, format, opts, { params: {}, op: 'inspect' });
		if (route.handled) return;

		progress('Loading and analyzing model…');
		const loaded = await loadInput(input, format);
		progressDone(`Analysis done (${loaded.inputInfo.meshes.length} submeshes)`);

		const om = new OutputManager(input);
		emitReport(
			{
				command: 'inspect',
				input: loaded.inputInfo,
				output: null,
				params: {},
				warnings: [...route.warnings, ...loaded.warnings],
				tier: route.tier,
				durationMs: Date.now() - startedAt,
			},
			{ reportPath: opts.report ?? om.reportPath('inspect'), json: !!opts.json },
		);
	}));
}
