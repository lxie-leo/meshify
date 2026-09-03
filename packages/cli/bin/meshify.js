#!/usr/bin/env node
// meshify CLI bin 入口（转发到 dist/index.js；保持 bin 零逻辑便于打包）
import('../dist/index.js').catch((err) => {
	process.stderr.write(`meshify 启动失败: ${err instanceof Error ? err.message : String(err)}\n`);
	process.exit(8);
});
