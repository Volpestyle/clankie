#!/usr/bin/env bash
# Run over administrator SSM after preserving/inspecting the old world.
# Requires /opt/clankie-minecraft/aws-guest.mjs (bundled from src/aws-guest.ts).
set -euo pipefail
umask 077
[ -f /opt/clankie-minecraft/aws-guest.mjs ] || { echo 'Guest bundle missing'; exit 1; }
dnf install -y java-21-amazon-corretto-headless haproxy
# Pin Node; verify its published SHA256 before installation.
node_version=v24.14.0
case "$(uname -m)" in x86_64) node_arch=x64;; aarch64) node_arch=arm64;; *) exit 1;; esac
node_archive="node-${node_version}-linux-${node_arch}.tar.xz"
node_tmp=$(mktemp -d)
trap 'rm -rf "$node_tmp"' EXIT
curl --fail --silent --show-error "https://nodejs.org/dist/${node_version}/${node_archive}" -o "$node_tmp/$node_archive"
curl --fail --silent --show-error "https://nodejs.org/dist/${node_version}/SHASUMS256.txt" -o "$node_tmp/SHA256SUMS"
(cd "$node_tmp" && grep " ${node_archive}$" SHA256SUMS | sha256sum -c -)
tar -xJf "$node_tmp/$node_archive" -C /opt
ln -sfn "/opt/node-${node_version}-linux-${node_arch}/bin/node" /usr/local/bin/node
mkdir -p /var/lib/clankie-minecraft
chmod 700 /var/lib/clankie-minecraft
cat > /usr/local/bin/clankie-minecraft-host <<'EOF'
#!/bin/sh
exec /usr/local/bin/node /opt/clankie-minecraft/aws-guest.mjs request "$1"
EOF
chmod 755 /usr/local/bin/clankie-minecraft-host
cat > /etc/haproxy/haproxy.cfg <<'EOF'
global
    user haproxy
    group haproxy
    maxconn 64
defaults
    mode tcp
    timeout connect 5s
    timeout client 2h
    timeout server 2h
frontend minecraft
    bind 0.0.0.0:25565
    default_backend paper
backend paper
    server local 127.0.0.1:25684 send-proxy-v2
EOF
haproxy -c -f /etc/haproxy/haproxy.cfg
cat > /etc/systemd/system/clankie-minecraft.service <<'EOF'
[Unit]
Description=Clankie Minecraft guest manager
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
ExecStart=/usr/local/bin/node /opt/clankie-minecraft/aws-guest.mjs serve
WorkingDirectory=/var/lib/clankie-minecraft
Environment=HOME=/var/lib/clankie-minecraft
Environment=CLANKIE_CREDENTIALS_PATH=/var/lib/clankie-minecraft/credentials.json
Restart=on-failure
RestartSec=10
TimeoutStopSec=120
UMask=0077
[Install]
WantedBy=multi-user.target
EOF
# Independent of the Node service: the machine never runs beyond six hours.
cat > /etc/systemd/system/clankie-minecraft-max-uptime.service <<'EOF'
[Unit]
Description=Absolute Minecraft instance uptime cap
[Service]
Type=oneshot
ExecStart=/usr/bin/systemctl poweroff
EOF
cat > /etc/systemd/system/clankie-minecraft-max-uptime.timer <<'EOF'
[Unit]
Description=Stop instance six hours after boot
[Timer]
OnBootSec=6h
Unit=clankie-minecraft-max-uptime.service
[Install]
WantedBy=timers.target
EOF
cat > /usr/local/bin/clankie-minecraft-health-stop <<'EOF'
#!/bin/bash
# Boot grace permits SSM provisioning; failed/crashed daemon cannot leave EC2 idle.
set -eu
uptime_seconds=${SECONDS:-0}
read -r uptime_seconds _ < /proc/uptime
if (( ${uptime_seconds%.*} < 900 )); then exit 0; fi
if ! systemctl is-active --quiet clankie-minecraft.service || ! timeout 15s /usr/local/bin/node /opt/clankie-minecraft/aws-guest.mjs health >/dev/null 2>&1; then
  systemctl poweroff
fi
EOF
chmod 755 /usr/local/bin/clankie-minecraft-health-stop
cat > /etc/systemd/system/clankie-minecraft-health-stop.service <<'EOF'
[Unit]
Description=Power off if Minecraft manager is unavailable
[Service]
Type=oneshot
ExecStart=/usr/local/bin/clankie-minecraft-health-stop
EOF
cat > /etc/systemd/system/clankie-minecraft-health-stop.timer <<'EOF'
[Unit]
Description=Check Minecraft manager every minute
[Timer]
OnBootSec=15min
OnUnitActiveSec=1min
[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable --now clankie-minecraft-max-uptime.timer clankie-minecraft-health-stop.timer
# Public ingress is admitted by the guest only after Paper authentication is ready.
# Close any listener left by an earlier installation and keep it disabled at boot.
systemctl disable --now haproxy
systemctl enable clankie-minecraft
# Explicit startup occurs only after SSM document/IAM and guest files are verified.
echo 'Guest installed; instance shutdown behavior MUST be stop. Minecraft remains off.'
