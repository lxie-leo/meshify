import * as process from 'node:process';

/**
 * CLI 进度提示：进度走 stderr（--json 的 stdout 保持纯净可管道）。
 * TTY 下单行覆盖刷新；非 TTY（重定向/CI）退化为普通行输出。
 */

const isTty = process.stderr.isTTY === true;
let lastLine = '';

export function progress(msg: string): void {
	if (isTty) {
		process.stderr.write(`\x1b[2m… ${msg}\x1b[0m\r`);
		lastLine = msg;
	} else {
		process.stderr.write(`[meshify] ${msg}\n`);
	}
}

export function progressDone(msg: string): void {
	if (isTty && lastLine) {
		process.stderr.write('\x1b[2K');
		lastLine = '';
	}
	process.stderr.write(`\x1b[2m✓ ${msg}\x1b[0m\n`);
}
