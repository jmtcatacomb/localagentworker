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
# Repair an earlier Agentworks AL2 preview that added Docker's incompatible
# CentOS repo. Leaving it enabled makes every subsequent yum transaction fail.
if [ -f /etc/yum.repos.d/docker-ce.repo ] && command -v yum-config-manager >/dev/null 2>&1; then
  sudo yum-config-manager --disable docker-ce-stable >/dev/null 2>&1 || true
fi
sudo yum install -y ca-certificates curl git python3 make gcc-c++ xz

if [ "$need_docker" = true ]; then
  # Docker's CentOS repository substitutes AL2's VERSION_ID ("2") into its
  # URL and returns 404.  Use the AL2-maintained Docker package instead.
  if command -v amazon-linux-extras >/dev/null 2>&1; then
    sudo amazon-linux-extras install -y docker
  else
    sudo yum install -y docker
  fi
  sudo systemctl enable --now docker
  sudo usermod -aG docker "${SUDO_USER:-$USER}"
fi

if ! docker compose version >/dev/null 2>&1; then
  # AL2's Docker package does not ship Compose v2.  Install the official
  # standalone CLI plugin at Docker's documented discovery path.  Pin the
  # version so a repeatable Host Agent run does not silently change binaries.
  compose_version=${AGENTWORKS_DOCKER_COMPOSE_VERSION:-v2.40.3}
  case "$(uname -m)" in x86_64) compose_arch=x86_64 ;; aarch64|arm64) compose_arch=aarch64 ;; *) echo "Unsupported Compose architecture: $(uname -m)" >&2; exit 1 ;; esac
  temp=$(mktemp)
  trap 'rm -f "$temp"' EXIT
  curl --fail --location --proto '=https' --tlsv1.2 \
    "https://github.com/docker/compose/releases/download/${compose_version}/docker-compose-linux-${compose_arch}" \
    -o "$temp"
  sudo install -D -m 0755 "$temp" /usr/local/lib/docker/cli-plugins/docker-compose
  docker compose version >/dev/null || { echo "Docker Compose v2 plugin installation failed." >&2; exit 1; }
  rm -f "$temp"
  trap - EXIT
fi

node_major=0
if command -v node >/dev/null 2>&1; then node_major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0); fi
if [ "$node_major" -lt 16 ]; then
  # AL2's glibc is 2.26. Current Node 18+ official binaries and NodeSource
  # RPMs require glibc 2.28. Node 16.20.2 is the newest official Linux binary
  # that executes on this target; its fetch API is enabled below via
  # --experimental-fetch for the Host Worker compatibility lane.
  node_version=${AGENTWORKS_NODE_VERSION:-v16.20.2}
  case "$(uname -m)" in x86_64) node_arch=x64 ;; aarch64|arm64) node_arch=arm64 ;; *) echo "Unsupported Node architecture: $(uname -m)" >&2; exit 1 ;; esac
  node_archive="node-${node_version}-linux-${node_arch}.tar.xz"
  node_tmp=$(mktemp)
  trap 'rm -f "$node_tmp"' EXIT
  sudo rm -f /etc/yum.repos.d/nodesource*.repo
  sudo yum clean all
  curl --fail --location --proto '=https' --tlsv1.2 "https://nodejs.org/dist/${node_version}/${node_archive}" -o "$node_tmp"
  sudo install -d -m 0755 /opt/agentworks-node
  sudo tar -xJf "$node_tmp" -C /opt/agentworks-node
  sudo ln -sfn "/opt/agentworks-node/node-${node_version}-linux-${node_arch}/bin/node" /usr/local/bin/node
  sudo ln -sfn "/opt/agentworks-node/node-${node_version}-linux-${node_arch}/bin/npm" /usr/local/bin/npm
  sudo ln -sfn "/opt/agentworks-node/node-${node_version}-linux-${node_arch}/bin/npx" /usr/local/bin/npx
  node --version | grep -Eq '^v1[6-9]\.|^v[2-9][0-9]\.' || { echo "Node 16+ installation failed." >&2; exit 1; }
  rm -f "$node_tmp"
  trap - EXIT
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
