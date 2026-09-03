import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	generateReport,
	validateReport,
	MeshifyError,
	EXIT_INTERNAL,
	type MeshifyReport,
} from '@meshify/core';

/**
 * 报告收尾：manifest 组装 → schema 校验 → 落盘 → 打印。
 * - 报告文件是工具自有日志（<input>.meshify/ 内），可自动覆盖；模型产物才受 --overwrite 约束
 * - --json 时 stdout 输出完整 manifest（供 Agent 消费），否则人类可读摘要
 */

export interface EmitOptions {
	reportPath: string;
	json: boolean;
}

export type ReportDraft = Parameters<typeof generateReport>[0];

/** 组装 + 校验 + 落盘 + 打印；返回最终 report。 */
export function emitReport(draft: ReportDraft, opts: EmitOptions): MeshifyReport {
	const report = generateReport(draft);
	return emitExistingReport(report, opts);
}

/** 已组装好的 manifest（Tier1 返回）校验 + 落盘 + 打印。 */
export function emitExistingReport(report: MeshifyReport, opts: EmitOptions): MeshifyReport {
	const validated = validateReport(report);
	if (!validated.ok) {
		// 契约违约属内部错误：报告照写（排障用），进程 exit 8
		const detail = validated.errors.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
		writeReportFile(opts.reportPath, { ...report, errors: [...report.errors, `manifest 未通过 schema 校验: ${detail}`] });
		throw new MeshifyError(EXIT_INTERNAL, `manifest 未通过 schema 校验（已写入 ${opts.reportPath}）: ${detail}`);
	}
	writeReportFile(opts.reportPath, report);
	if (opts.json) {
		process.stdout.write(JSON.stringify(report, null, 2) + '\n');
	} else {
		printSummary(report, opts.reportPath);
	}
	return report;
}

function writeReportFile(p: string, report: MeshifyReport): void {
	fs.mkdirSync(path.dirname(p), { recursive: true });
	fs.writeFileSync(p, JSON.stringify(report, null, 2), 'utf-8');
}

/** 人类可读摘要（stdout；--json 时替换为完整 manifest）。 */
export function printSummary(report: MeshifyReport, reportPath: string): void {
	const lines: string[] = [];
	const tier = report.tool.tier === 'python-uv' ? 'Tier1 python-uv' : 'Tier0 ts-wasm';
	lines.push(`meshify ${report.command} 完成（${(report.metrics.duration_ms / 1000).toFixed(2)}s，${tier}）`);
	lines.push(
		`  输入  ${report.input.path}（${report.input.format}，${fmtCount(report.input.faces)} 面，${fmtBytes(report.input.bytes)}）`,
	);
	if (report.output) {
		lines.push(
			`  输出  ${report.output.path}（${fmtCount(report.output.faces)} 面，${fmtBytes(report.output.bytes)}）`,
		);
		if (report.metrics.face_reduction !== undefined) {
			lines.push(
				`  面数  ${fmtCount(report.input.faces)} → ${fmtCount(report.output.faces)}（保留 ${(
					100 * (1 - report.metrics.face_reduction)
				).toFixed(1)}%）`,
			);
		}
		if (report.metrics.byte_reduction !== undefined) {
			// 正值 = 减小；负值（如绑贴图后变大）显示 +
			const pct = 100 * report.metrics.byte_reduction;
			lines.push(
				`  体积  ${fmtBytes(report.input.bytes)} → ${fmtBytes(report.output.bytes)}（${pct >= 0 ? '-' : '+'}${Math.abs(pct).toFixed(1)}%）`,
			);
		}
		if (report.metrics.parts) {
			lines.push(`  部件  ${report.metrics.parts.length} 个`);
		}
		if (report.metrics.lod_levels) {
			lines.push(
				`  LOD  ${report.metrics.lod_levels.map((l) => `L${l.level}:${fmtCount(l.faces)}面`).join('，')}`,
			);
		}
	}
	for (const w of report.warnings) {
		lines.push(`  警告  [${w.code}] ${w.message}`);
	}
	for (const e of report.errors) {
		lines.push(`  错误  ${e}`);
	}
	lines.push(`  报告  ${reportPath}`);
	process.stdout.write(lines.join('\n') + '\n');
}

export function fmtCount(n: number): string {
	return n.toLocaleString('en-US');
}

export function fmtBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
