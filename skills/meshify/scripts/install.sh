#!/usr/bin/env sh
# meshify skill 安装器（Unix）
# 用法：sh install.sh [--cli-only|--skill-only]
# 行为：
#   1. 探测 Agent 宿主 skills 目录（.claude/.cursor/.agents/…，存在即装）
#   2. 复制 SKILL.md + references/ 到各宿主目录
#   3. 仓库内构建 CLI（未构建时）并跑 meshify doctor 写安装摘要
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
		echo "  构建内核与 CLI（pnpm install + tsc）…"
		cd "$REPO_ROOT"
		command -v pnpm >/dev/null 2>&1 || { echo "  [FAIL] 需要 pnpm（npm i -g pnpm）"; exit 1; }
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
		echo "  环境自检："
		node "$CLI" doctor || true
	else
		echo "  [--] CLI 未构建（--cli-only 可单独构建）"
	fi
}

echo "meshify skill 安装器"

if [ "$MODE" = "all" ] || [ "$MODE" = "skill-only" ]; then
	echo "探测宿主 skills 目录…"
	for host in $(detect_hosts); do
		install_skill "$host"
	done
fi

if [ "$MODE" = "all" ] || [ "$MODE" = "cli-only" ]; then
	build_cli
	run_doctor
fi

echo "完成。验证：node packages/cli/bin/meshify.js inspect <model.glb>"
echo "Tier1（STEP/CAD）按需安装：meshify doctor --install-uv && cd packages-py/kernel-py && uv sync"
