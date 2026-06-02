#!/bin/sh
# Concord — LiveKit startup wrapper.
#
# LiveKit doesn't natively interpolate env vars into its YAML config,
# and `use_external_ip: true` (the production default) does an
# uncontrolled STUN discovery that returns the host's public WAN IP.
# On a Tailscale-only dev origin that public IP is unreachable from
# any tailnet peer, so every ICE candidate pair times out and the
# RTCPeerConnection fails with "could not establish pc connection".
#
# Setting `--node-ip` alone is NOT enough: when `use_external_ip:
# true` lives in the YAML it wins over the CLI override for the
# advertised ICE candidate IP (the candidate comes from
# rtcconfig.NAT1To1Ips, which is filled from STUN when
# use_external_ip is true). We therefore template a runtime YAML
# that turns off the STUN path and pins node_ip when an operator
# supplies LIVEKIT_RTC_NODE_IP. Otherwise we pass the original YAML
# through unchanged so production keeps the STUN-discovery default.
set -eu

SRC_CONFIG="${LIVEKIT_CONFIG_FILE:-/etc/livekit.yaml}"
RUN_CONFIG="/tmp/livekit.runtime.yaml"

if [ -n "${LIVEKIT_RTC_NODE_IP:-}" ]; then
  # Rewrite `use_external_ip: true` to `false` and inject node_ip
  # right after the `rtc:` header. sed is portable and the YAML
  # surface we're rewriting is small + stable.
  sed -e 's/^\(\s*\)use_external_ip:\s*true\s*$/\1use_external_ip: false/' \
      -e "s|^\(rtc:\s*\)$|\1\n  node_ip: ${LIVEKIT_RTC_NODE_IP}|" \
      "${SRC_CONFIG}" > "${RUN_CONFIG}"
else
  cp "${SRC_CONFIG}" "${RUN_CONFIG}"
fi

exec /livekit-server --config "${RUN_CONFIG}" "$@"
