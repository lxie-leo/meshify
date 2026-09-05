#!/usr/bin/env sh
# meshify skill installer (Unix)
# Usage: sh install.sh [--cli-only|--skill-only]
# Behavior:
#   1. Detect agent host skills directories (.claude/.cursor/.agents/..., install wherever found)
#   2. Copy SKILL.md + references/ into each host directory
#   3. Build the CLI in-repo (if not built yet) and run meshify doctor for a summary
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
SKILL_DIR="$(dirname "$HERE")"           # skills/meshify
REPO_ROOT="$(dirname "$(dirname "$SKILL_DIR")")"  # 仓库根（skills/ 的上级）

MODE="${1:-all}"   # all | cli-only | skill-only

# ------------------------------------------------------------------
# 1. 宿主探测
# ------------------------------------------------------------------
detect_hosts() {
	hosts=""
	for h in \
		".claude/skills" \
		".cursor/skills" \
		".agents/skills" \
		".codex/skills" \
		".qoder/skills" \
		".codebuddy/skills" \
		".comate/skills"; do
		d="$REPO_ROOT/$h"
		if [ -d "$(dirname "$d")" ] || [ -d "$d" ]; then
			hosts="$hosts $d"
		fi
	done
	# 都没有：默认装 Claude Code 布局（mkdir -p 由安装步骤完成）
	if [ -z "$hosts" ]; then
		hosts="$REPO_ROOT/.claude/skills"
	fi
	echo "$hosts"
}

install_skill() {
	target="$1/meshify"
	mkdir -p "$target/references"
	cp "$SKILL_DIR/SKILL.md" "$target/SKILL.md"
	cp "$SKILL_DIR"/references/*.md "$target/references/"
	echo "  [ok] skill -> $target"
}

# ------------------------------------------------------------------
# 2. CLI 构建（仓库内使用；npm 发布后可 npx meshify）
# ------------------------------------------------------------------
build_cli() {
	if [ ! -f "$REPO_ROOT/packages/cli/dist/index.js" ]; then
		echo "  Building kernel and CLI (pnpm install + tsc)..."
		cd "$REPO_ROOT"
		command -v pnpm >/dev/null 2>&1 || { echo "  [FAIL] pnpm is required (npm i -g pnpm)"; exit 1; }
		pnpm install --silent
		(cd packages/core && npx tsc -p tsconfig.json)
		(cd packages/kernel-ts && npx tsc -p tsconfig.json)
		(cd packages/cli && npx tsc -p tsconfig.json)
	fi
}

# ------------------------------------------------------------------
# 3. doctor 摘要
# ------------------------------------------------------------------
run_doctor() {
	CLI="$REPO_ROOT/packages/cli/bin/meshify.js"
	if [ -f "$CLI" ]; then
		echo "  Environment check:"
		node "$CLI" doctor || true
	else
		echo "  [--] CLI not built (--cli-only builds it alone)"
	fi
}

echo "meshify skill installer"

if [ "$MODE" = "all" ] || [ "$MODE" = "skill-only" ]; then
	echo "Detecting host skills directories..."
	for host in $(detect_hosts); do
		install_skill "$host"
	done
fi

if [ "$MODE" = "all" ] || [ "$MODE" = "cli-only" ]; then
	build_cli
	run_doctor
fi

echo "Done. Verify: node packages/cli/bin/meshify.js inspect <model.glb>"
echo "Tier1 (STEP/CAD) on demand: meshify doctor --install-uv && cd packages-py/kernel-py && uv sync"
