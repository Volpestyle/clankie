#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

bash -n infra/aws/public-gateway/deploy.sh infra/aws/public-gateway/activate-release.sh
[[ "$(infra/aws/public-gateway/activate-release.sh --version)" == 3 ]]

# Push mounts, exercised without docker, root, or any mutation.
push_root="$(mktemp -d)"
trap 'rm -rf -- "$push_root"' EXIT
disabled="$(CLANKIE_GATEWAY_CONFIG_ROOT="$push_root" infra/aws/public-gateway/activate-release.sh --dry-run)"
[[ "$disabled" == *"push disabled"* && "$disabled" != *"CLANKIE_GATEWAY_PUSH_CONFIG_FILE"* ]] || {
  echo "An unconfigured gateway must mount nothing for push" >&2
  exit 1
}
: >"$push_root/push.json"
enabled="$(CLANKIE_GATEWAY_CONFIG_ROOT="$push_root" infra/aws/public-gateway/activate-release.sh --dry-run)"
for expected in   "arg --env CLANKIE_GATEWAY_PUSH_CONFIG_FILE=/run/config/push.json"   "target=/run/config/push.json,readonly"   "target=/run/secrets/apns.p8,readonly"   "target=/var/lib/clankie-gateway"   "requires $push_root/apns.p8 root:clankie-gateway-secrets:640"   "requires /var/lib/clankie-gateway/push uid:1000:700"; do
  [[ "$enabled" == *"$expected"* ]] || {
    echo "Push activation is missing: $expected" >&2
    exit 1
  }
done
# The data mount is the only writable one, and the container stays read-only.
[[ "$enabled" != *"target=/var/lib/clankie-gateway,readonly"* ]] || {
  echo "The push database mount must be writable" >&2
  exit 1
}
grep -q -- "--read-only" infra/aws/public-gateway/activate-release.sh || {
  echo "The gateway container must stay read-only" >&2
  exit 1
}
# The config-root override is a dry-run affordance, never a deployment one.
if CLANKIE_GATEWAY_CONFIG_ROOT="$push_root" infra/aws/public-gateway/activate-release.sh /tmp/x y >/dev/null 2>&1; then
  echo "A real activation accepted an overridden config root" >&2
  exit 1
fi
rm -rf -- "$push_root"
trap - EXIT
jq -e . infra/aws/public-gateway/tailnet-policy.fragment.hujson >/dev/null

instance_name="$(sed -n 's/^      InstanceName: //p' infra/aws/public-gateway/template.yaml)"
static_ip_name="$(sed -n 's/^      StaticIpName: //p' infra/aws/public-gateway/template.yaml)"
[[ -n "$instance_name" && -n "$static_ip_name" && "$instance_name" != "$static_ip_name" ]] || {
  echo "Lightsail instance and static IP names must be distinct" >&2
  exit 1
}

if CLANKIE_AWS_REGION=test CLANKIE_GATEWAY_KEY_PAIR_NAME=test CLANKIE_GATEWAY_PUBLIC_SSH=invalid \
  infra/aws/public-gateway/deploy.sh provision >/dev/null 2>&1; then
  echo "Invalid public SSH configuration was accepted" >&2
  exit 1
fi

# Render a self-hosted release with no Docker daemon or network access.
work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT
export TEST_CAPTURE="$work" TEST_REPO_ROOT="$repo_root"
cat >"$work/git" <<'GIT'
#!/usr/bin/env bash
case "$*" in
  'rev-parse --show-toplevel') echo "$TEST_REPO_ROOT" ;;
  'rev-parse --short=12 HEAD') echo abcdef123456 ;;
  'status --porcelain --untracked-files=normal') ;;
  *) exit 1 ;;
esac
GIT
cat >"$work/ssh" <<'SSH'
#!/usr/bin/env bash
[[ "$*" != *'--version'* ]] || echo 3
exit 0
SSH
cat >"$work/docker" <<'DOCKER'
#!/usr/bin/env bash
[[ "$1" != save ]] || touch "$3"
exit 0
DOCKER
cat >"$work/scp" <<'SCP'
#!/usr/bin/env bash
for arg in "$@"; do
  case "$arg" in
    */Caddyfile) cp "$arg" "$TEST_CAPTURE/Caddyfile" ;;
  esac
done
SCP
chmod +x "$work/git" "$work/ssh" "$work/docker" "$work/scp"
export PATH="$work:$PATH"
export CLANKIE_GATEWAY_TARGET=gateway.example.com
if CLANKIE_GATEWAY_DOMAIN='bad;domain' infra/aws/public-gateway/deploy.sh release >/dev/null 2>&1; then
  echo "Invalid gateway domain was accepted" >&2
  exit 1
fi
CLANKIE_GATEWAY_DOMAIN=api.example.com infra/aws/public-gateway/deploy.sh release
sed 's/__GATEWAY_DOMAIN__/api.example.com/g' infra/aws/public-gateway/Caddyfile >"$work/expected"
cmp "$work/expected" "$work/Caddyfile"
