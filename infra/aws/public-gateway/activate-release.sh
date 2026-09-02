#!/usr/bin/env bash
set -euo pipefail

readonly activator_version=2
readonly caddy_image=caddy:2.11.4-alpine
readonly secret_file=/etc/clankie-gateway/host-tokens.json
readonly account_file=/etc/clankie-gateway/account.json
readonly caddy_file=/opt/clankie-gateway/Caddyfile

if [[ "${1:-}" == "--version" ]]; then
  echo "$activator_version"
  exit 0
fi

if [[ $EUID -ne 0 || -z "${SUDO_USER:-}" || "$SUDO_USER" == root || $# -ne 2 ]]; then
  echo "Usage: sudo $0 /tmp/clankie-gateway-<release-id> clankie-public-gateway:<release-id>" >&2
  exit 2
fi

release_dir="$1"
image_ref="$2"
release_id="${release_dir#/tmp/clankie-gateway-}"

[[ "$release_dir" == "/tmp/clankie-gateway-$release_id" && "$release_id" =~ ^[0-9a-f]{7,40}-[0-9]{14}$ ]] || {
  echo "Refusing unexpected release directory: $release_dir" >&2
  exit 1
}
[[ "$image_ref" == "clankie-public-gateway:$release_id" ]] || {
  echo "Image tag does not match the release directory" >&2
  exit 1
}
[[ -d "$release_dir" && ! -L "$release_dir" && "$(stat -c %U "$release_dir")" == "$SUDO_USER" ]] || {
  echo "$release_dir must be a real directory owned by $SUDO_USER" >&2
  exit 1
}
for release_file in gateway-image.tar Caddyfile; do
  path="$release_dir/$release_file"
  [[ -f "$path" && ! -L "$path" && "$(stat -c %U "$path")" == "$SUDO_USER" ]] || {
    echo "$path must be a regular file owned by $SUDO_USER" >&2
    exit 1
  }
done

previous_caddy=""
cleanup() {
  rm -rf -- "$release_dir"
  [[ -z "$previous_caddy" ]] || rm -f -- "$previous_caddy"
}
trap cleanup EXIT

gateway_config_args=()
if [[ -e "$secret_file" ]]; then
  [[ -r "$secret_file" && "$(stat -c %U:%G:%a "$secret_file")" == "root:clankie-gateway-secrets:640" ]] || {
    echo "$secret_file must be root:clankie-gateway-secrets mode 0640" >&2
    exit 1
  }
  gateway_config_args+=(
    --env CLANKIE_GATEWAY_HOST_TOKENS_FILE=/run/secrets/host-tokens.json
    --mount "type=bind,source=$secret_file,target=/run/secrets/host-tokens.json,readonly"
  )
fi
if [[ -e "$account_file" ]]; then
  [[ -r "$account_file" && "$(stat -c %U:%G:%a "$account_file")" == "root:root:644" ]] || {
    echo "$account_file must be root:root mode 0644" >&2
    exit 1
  }
  gateway_config_args+=(
    --env CLANKIE_GATEWAY_ACCOUNT_CONFIG_FILE=/run/config/account.json
    --mount "type=bind,source=$account_file,target=/run/config/account.json,readonly"
  )
fi
[[ ${#gateway_config_args[@]} -gt 0 ]] || {
  echo "Configure $account_file or the legacy $secret_file before release" >&2
  exit 1
}

docker load --input "$release_dir/gateway-image.tar"
docker pull "$caddy_image"
docker network inspect clankie-gateway >/dev/null 2>&1 || docker network create clankie-gateway >/dev/null
docker volume create clankie-caddy-data >/dev/null
docker volume create clankie-caddy-config >/dev/null
docker run --rm \
  --network clankie-gateway \
  --mount "type=bind,source=$release_dir/Caddyfile,target=/etc/caddy/Caddyfile,readonly" \
  "$caddy_image" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null

start_gateway() {
  docker run --detach \
    --name clankie-gateway \
    --network clankie-gateway \
    --restart unless-stopped \
    --read-only \
    --tmpfs /tmp:rw,noexec,nosuid,size=16m \
    --security-opt no-new-privileges:true \
    --cap-drop ALL \
    --group-add 1999 \
    --memory 640m \
    --env NODE_OPTIONS=--max-old-space-size=384 \
    "${gateway_config_args[@]}" \
    --health-cmd='node -e "fetch(\"http://127.0.0.1:8080/health\").then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"' \
    --health-interval 10s \
    --health-timeout 5s \
    --health-retries 3 \
    --health-start-period 5s \
    "$1" >/dev/null
}

previous_image="$(docker inspect --format '{{.Config.Image}}' clankie-gateway 2>/dev/null || true)"
docker rm --force clankie-gateway >/dev/null 2>&1 || true
gateway_health=""
if start_gateway "$image_ref"; then
  for _ in $(seq 1 30); do
    gateway_health="$(docker inspect --format '{{.State.Health.Status}}' clankie-gateway 2>/dev/null || true)"
    [[ "$gateway_health" == healthy ]] && break
    sleep 1
  done
fi
if [[ "$gateway_health" != healthy ]]; then
  docker logs --tail 100 clankie-gateway >&2 || true
  docker rm --force clankie-gateway >/dev/null 2>&1 || true
  [[ -z "$previous_image" ]] || start_gateway "$previous_image"
  echo "Gateway failed its local health check; the previous image was restored when available" >&2
  exit 1
fi

previous_caddy="$(mktemp)"
had_previous_caddy=false
if [[ -f "$caddy_file" ]]; then
  cp "$caddy_file" "$previous_caddy"
  had_previous_caddy=true
fi
install -o root -g root -m 0644 "$release_dir/Caddyfile" "$caddy_file"

start_caddy() {
  docker run --detach \
    --name clankie-caddy \
    --network clankie-gateway \
    --restart unless-stopped \
    --read-only \
    --tmpfs /tmp:rw,noexec,nosuid,size=16m \
    --security-opt no-new-privileges:true \
    --cap-drop ALL \
    --cap-add NET_BIND_SERVICE \
    --memory 192m \
    --publish 80:80 \
    --publish 443:443 \
    --mount "type=bind,source=$caddy_file,target=/etc/caddy/Caddyfile,readonly" \
    --mount type=volume,source=clankie-caddy-data,target=/data \
    --mount type=volume,source=clankie-caddy-config,target=/config \
    "$caddy_image" >/dev/null
}

docker rm --force clankie-caddy >/dev/null 2>&1 || true
caddy_running=false
if start_caddy; then
  sleep 2
  caddy_running="$(docker inspect --format '{{.State.Running}}' clankie-caddy 2>/dev/null || true)"
fi
if [[ "$caddy_running" != true ]]; then
  docker logs --tail 100 clankie-caddy >&2 || true
  docker rm --force clankie-caddy >/dev/null 2>&1 || true
  if [[ "$had_previous_caddy" == true ]]; then
    install -o root -g root -m 0644 "$previous_caddy" "$caddy_file"
    start_caddy
  fi
  echo "Caddy failed to start; the previous configuration was restored when available" >&2
  exit 1
fi
rm -f -- "$previous_caddy"
previous_caddy=""

echo "Released $image_ref"
