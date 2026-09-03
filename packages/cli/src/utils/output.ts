import * as fs from 'node:fs';
import * as path from 'node:path';
import { MeshifyError, EXIT_PARAM_CONFLICT } from '@meshify/core';

/**
 * 输出管理（plan §Step 1.4）：
 * - 默认输出目录 `<inputDir>/<inputName>.meshify/`，产物命名 `<name>.<op>.<ext>`
 * - 默认永不覆盖输入与已存在输出（重复执行幂等安全），显式 `--overwrite` 才覆盖
 *   → 拒绝覆盖 = exit 4（参数冲突语义：用户需显式表态）
 * - `-o` 显式指定单文件输出（或 segment 的输出目录）
 */

export interface OutputManagerOptions {
	overwrite?: boolean;
	/** -o 显式输出（单文件命令 = 文件路径；segment = 目录） */
	explicit?: string;
}

/**
 * Windows（NTFS）与 macOS（HFS+/APFS 默认）文件系统大小写不敏感：
 * `PROOF.glb` 与 `proof.glb` 是同一文件，路径比较必须归一大小写，
 * 否则「永不覆盖输入」保护可被大小写变体绕过。Linux 保持精确比较。
 */
const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin';

function samePath(a: string, b: string): boolean {
	return CASE_INSENSITIVE_FS ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export class OutputManager {
	readonly inputPath: string;
	readonly inputDir: string;
	readonly inputName: string;
	/** 默认输出目录：<inputDir>/<inputName>.meshify */
	readonly baseDir: string;
	readonly overwrite: boolean;
	readonly explicit: string | undefined;
	private readonly claimed = new Set<string>();

	constructor(inputPath: string, opts: OutputManagerOptions = {}) {
		this.inputPath = path.resolve(inputPath);
		this.inputDir = path.dirname(this.inputPath);
		this.inputName = parseName(this.inputPath);
		this.baseDir = path.join(this.inputDir, `${this.inputName}.meshify`);
		this.overwrite = !!opts.overwrite;
		this.explicit = opts.explicit ? path.resolve(opts.explicit) : undefined;
	}

	/** 单文件输出默认路径（-o 覆盖）。 */
	file(op: string, ext: string): string {
		if (this.explicit) return this.explicit;
		return path.join(this.baseDir, `${this.inputName}.${op}.${ext}`);
	}

	/** 多部件输出目录（segment）：`<base>/<name>.<op>/`（-o 覆盖）。 */
	partDir(op: string): string {
		if (this.explicit) return this.explicit;
		return path.join(this.baseDir, `${this.inputName}.${op}`);
	}

	/** 报告（manifest）路径。 */
	reportPath(op: string): string {
		return path.join(this.explicit ? path.dirname(this.explicit) : this.baseDir, `${this.inputName}.${op}.report.json`);
	}

	/** 预览页路径（与主产物同目录）。 */
	previewPath(mainOutput: string): string {
		const dir = path.dirname(mainOutput);
		const ext = path.extname(mainOutput);
		const stem = path.basename(mainOutput, ext);
		return path.join(dir, `${stem}.preview.html`);
	}

	/** 声明即将写入的路径：存在且未 --overwrite → exit 4；等于输入路径 → 永久拒绝。 */
	claim(target: string): string {
		const abs = path.resolve(target);
		// 大小写不敏感 FS 上 -o PROOF.glb 也能命中输入 proof.glb（samePath 归一比较）
		if (samePath(abs, this.inputPath)) {
			throw new MeshifyError(
				EXIT_PARAM_CONFLICT,
				`输出路径与输入相同: ${abs}。拒绝覆盖输入文件（--overwrite 也不能覆盖输入）。`,
			);
		}
		const claimKey = CASE_INSENSITIVE_FS ? abs.toLowerCase() : abs;
		if (this.claimed.has(claimKey)) return abs;
		if (fs.existsSync(abs) && !this.overwrite) {
			throw new MeshifyError(
				EXIT_PARAM_CONFLICT,
				`输出已存在: ${abs}。默认不覆盖既有产物；确认覆盖请加 --overwrite。`,
			);
		}
		this.claimed.add(claimKey);
		return abs;
	}

	ensureDirFor(file: string): void {
		fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
	}

	ensureDir(dir: string): string {
		fs.mkdirSync(path.resolve(dir), { recursive: true });
		return dir;
	}
}

/** 文件名去扩展名（多段后缀如 .tar.gz 不特殊处理，模型场景够用）。 */
function parseName(p: string): string {
	return path.basename(p, path.extname(p)) || 'model';
}
