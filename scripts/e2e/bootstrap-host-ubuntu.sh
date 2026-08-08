#!/bin/sh
# Minimal, explicit host prerequisite bootstrap for the Ubuntu Host Agent E2E.
#
# It intentionally installs only Docker Engine/Compose and Node.js 24 needed by
# the checked-in installer. It does not install Codex, inject credentials, create
# tenant VMs, or change firewall rules. Run only after the host plan is approved.
set -eu

if [ "${AGENTWORKS_HOST_BOOTSTRAP:-}" != "ubuntu" ]; then
  echo "Refusing host mutation. Run with AGENTWORKS_HOST_BOOTSTRAP=ubuntu." >&2
  exit 2
fi
if [ "$(uname -s)" != "Linux" ] || ! command -v apt-get >/dev/null 2>&1; then
  echo "This bootstrap is for apt-based Ubuntu hosts only." >&2
  exit 2
fi
if [ ! -e /dev/kvm ]; then
  echo "/dev/kvm is unavailable; do not install Agentworks VM isolation on this host." >&2
  exit 2
fi

need_docker=false
command -v docker >/dev/null 2>&1 || need_docker=true
if [ "$need_docker" = true ]; then
  sudo apt-get update
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl git docker.io docker-compose-v2
  sudo systemctl enable --now docker
  sudo usermod -aG docker "${SUDO_USER:-$USER}"
fi

node_major=0
if command -v node >/dev/null 2>&1; then node_major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0); fi
if [ "$node_major" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs
fi

echo "Ubuntu host prerequisites ready. Reconnect your SSH session so the docker group membership takes effect."
