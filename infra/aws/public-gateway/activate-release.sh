#!/usr/bin/env bash
set -euo pipefail

readonly activator_version=3
readonly caddy_image=caddy:2.11.4-alpine
# Overridable only for --dry-run; a real activation refuses anything else.
config_root="${CLANKIE_GATEWAY_CONFIG_ROOT:-/etc/clankie-gateway}"
readonly config_root
readonly secret_file="$config_root/host-tokens.json"
readonly account_file="$config_root/account.json"
readonly push_config_file="$config_root/push.json"
readonly push_key_file="$config_root/apns.p8"
readonly caddy_file=/opt/clankie-gateway/Caddyfile
# APNs delivery (ADR 0159): read-only config and key, one writable directory for
# the registration database. `node` in the runtime image is uid 1000.
readonly push_data_dir=/var/lib/clankie-gateway/push
readonly push_data_target=/var/lib/clankie-gateway
readonly push_runtime_uid=1000
push_mount_args=(
  --env CLANKIE_GATEWAY_PUSH_CONFIG_FILE=/run/config/push.json
  --mount "type=bind,source=$push_config_file,target=/run/config/push.json,readonly"
  --mount "type=bind,source=$push_key_file,target=/run/secrets/apns.p8,readonly"
  --mount "type=bind,source=$push_data_dir,target=$push_data_target"
)

if [[ "${1:-}" == "--version" ]]; then
  echo "$activator_version"
  exit 0
fi

# Prints what a real activation would mount for the current config root, and
# nothing else: no root, no docker, no mutation. This is what the repository
# check exercises.
if [[ "${1:-}" == "--dry-run" ]]; then
  echo "config-root $config_root"
  if [[ -e "$push_config_file" ]]; then
    echo "requires $push_config_file root:root:644"
    echo "requires $push_key_file root:clankie-gateway-secrets:640"
    echo "requires $push_data_dir uid:$push_runtime_uid:700"
    echo "requires image-user node"
    for ((i=0; i<${#push_mount_args[@]}; i+=2)); do
      echo "arg ${push_mount_args[i]} ${push_mount_args[i+1]}"
    done
  else
    echo "push disabled"
  fi
  exit 0
fi

[[ "$config_root" == /etc/clankie-gateway ]] || {
  echo "CLANKIE_GATEWAY_CONFIG_ROOT is for --dry-run only" >&2
  exit 2
}

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

# Push is opt-in and entirely absent unless the operator placed push.json.
push_enabled=false
if [[ -e "$push_config_file" ]]; then
  push_enabled=true
  [[ -f "$push_config_file" && ! -L "$push_config_file" && "$(stat -c %U:%G:%a "$push_config_file")" == "root:root:644" ]] || {
    echo "$push_config_file must be a regular root:root mode 0644 file" >&2
    exit 1
  }
  [[ -f "$push_key_file" && ! -L "$push_key_file" && "$(stat -c %U:%G:%a "$push_key_file")" == "root:clankie-gateway-secrets:640" ]] || {
    echo "$push_key_file must be a regular root:clankie-gateway-secrets mode 0640 file" >&2
    exit 1
  }
  # The registration database is the delivery authorization for every paired
  # phone. It lives outside the read-only container on a host directory the
  # runtime user owns, so it survives a release and nothing else can read it.
  [[ -d "$push_data_dir" && ! -L "$push_data_dir" && "$(stat -c %u:%a "$push_data_dir")" == "$push_runtime_uid:700" ]] || {
    echo "$push_data_dir must be a real directory owned by uid $push_runtime_uid mode 0700" >&2
    echo "  install -d -o $push_runtime_uid -g $push_runtime_uid -m 0700 $push_data_dir" >&2
    exit 1
  }
  gateway_config_args+=("${push_mount_args[@]}")
fi

docker load --input "$release_dir/gateway-image.tar"
if [[ "$push_enabled" == true ]]; then
  # The directory ownership above only works if the image still runs as `node`.
  image_user="$(docker image inspect --format '{{.Config.User}}' "$image_ref")"
  [[ "$image_user" == node || "$image_user" == "$push_runtime_uid" ]] || {
    echo "Image runs as '${image_user:-root}'; $push_data_dir is owned by uid $push_runtime_uid" >&2
    exit 1
  }
fi
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
