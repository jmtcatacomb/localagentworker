#!/bin/sh
# Permit only LXD bridge forwarding through Docker's explicit user firewall hook.
# Docker otherwise sets FORWARD=DROP, which breaks LXD VM NAT on a shared host.
set -eu

bridge=${1:-lxdbr0}
command -v iptables >/dev/null 2>&1 || exit 0
iptables -S DOCKER-USER >/dev/null 2>&1 || exit 0
iptables -C DOCKER-USER -i "$bridge" -j ACCEPT 2>/dev/null || iptables -I DOCKER-USER -i "$bridge" -j ACCEPT
iptables -C DOCKER-USER -o "$bridge" -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT 2>/dev/null || iptables -I DOCKER-USER -o "$bridge" -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
