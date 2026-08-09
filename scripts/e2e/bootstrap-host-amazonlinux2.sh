#!/bin/sh
# Minimal Amazon Linux 2 prerequisite bootstrap for the Host Agent E2E.
#
# This path preserves VM isolation: it installs Docker/Node and the LXD snap
# runtime, then lets the normal Linux Worker launch Ubuntu VM instances through
# KVM.  It intentionally refuses a container fallback when nested
# virtualization, snapd, or LXD cannot be made available.
set -eu

if [ "${AGENTWORKS_HOST_BOOTSTRAP:-}" != "amazonlinux2" ]; then
  echo "Refusing host mutation. Run with AGENTWORKS_HOST_BOOTSTRAP=amazonlinux2." >&2
  exit 2
fi
if [ "$(uname -s)" != "Linux" ] || ! command -v yum >/dev/null 2>&1; then
  echo "This bootstrap is for Amazon Linux 2/RPM hosts only." >&2
  exit 2
fi
if [ ! -e /dev/kvm ]; then
  echo "/dev/kvm is unavailable; do not install Agentworks VM isolation on this host." >&2
  exit 2
fi

need_docker=false
command -v docker >/dev/null 2>&1 || need_docker=true
sudo yum install -y ca-certificates curl git python3 make gcc-c++

if [ "$need_docker" = true ]; then
  # The Docker CE repository supplies both Engine and Compose v2 for AL2.
  sudo yum install -y yum-utils
  sudo yum-config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
  sudo yum install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  sudo systemctl enable --now docker
  sudo usermod -aG docker "${SUDO_USER:-$USER}"
fi

node_major=0
if command -v node >/dev/null 2>&1; then node_major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0); fi
if [ "$node_major" -lt 22 ]; then
  curl -fsSL https://rpm.nodesource.com/setup_24.x | sudo bash -
  sudo yum install -y nodejs
fi

if ! command -v lxc >/dev/null 2>&1; then
  # AL2 has no supported Incus package. LXD's documented portable path is
  # snapd + the LXD snap; fail closed if the host image cannot provide it.
  sudo yum install -y snapd
  sudo systemctl enable --now snapd.socket
  if [ ! -e /snap ]; then sudo ln -s /var/lib/snapd/snap /snap; fi
  for attempt in 1 2 3 4 5 6 7 8 9 10; do
    if sudo snap install lxd --channel=5.21/stable; then break; fi
    [ "$attempt" = 10 ] && { echo "LXD snap installation failed; VM isolation is unavailable on this host." >&2; exit 1; }
    sleep 3
  done
  sudo lxd init --minimal
fi
sudo usermod -aG lxd "${SUDO_USER:-$USER}"

echo "Amazon Linux 2 prerequisites ready. Reconnect SSH before running ./agentworks install so docker/lxd group membership takes effect."
