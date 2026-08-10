#!/bin/sh
# Install the two supported native harnesses for the host-side Master Agent.
# This is an explicit host mutation and is never run by `agentworks install`.
set -eu

if [ "$(id -u)" = 0 ]; then
  echo "Run this command as the Agentworks host service user, not root." >&2
  exit 2
fi
if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required to install the native agent CLIs." >&2
  exit 2
fi

mkdir -p "$HOME/.local/bin"
export PATH="$HOME/.local/bin:$PATH"

if ! command -v codex >/dev/null 2>&1; then
  curl -fsSL https://chatgpt.com/codex/install.sh | sh
fi
if ! command -v claude >/dev/null 2>&1; then
  curl -fsSL https://claude.ai/install.sh | bash
fi

codex --version
claude --version
echo "Master Agent native CLIs are ready. Import/login credentials separately under .agentworks/."
