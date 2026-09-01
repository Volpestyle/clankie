#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

region="${CLANKIE_AWS_REGION:?Set CLANKIE_AWS_REGION}"
stack_name="${CLANKIE_GATEWAY_STACK:-clankie-public-gateway}"
command_name="${1:-}"

case "$command_name" in
  provision)
    : "${CLANKIE_GATEWAY_KEY_PAIR_NAME:?Set CLANKIE_GATEWAY_KEY_PAIR_NAME}"
    : "${CLANKIE_GATEWAY_OPERATOR_CIDR:?Set CLANKIE_GATEWAY_OPERATOR_CIDR to your public IPv4 /32}"
    aws cloudformation deploy \
      --region "$region" \
      --stack-name "$stack_name" \
      --template-file infra/aws/public-gateway/template.yaml \
      --parameter-overrides \
        "KeyPairName=$CLANKIE_GATEWAY_KEY_PAIR_NAME" \
        "OperatorCidr=$CLANKIE_GATEWAY_OPERATOR_CIDR"
    aws cloudformation describe-stacks \
      --region "$region" \
      --stack-name "$stack_name" \
      --query 'Stacks[0].Outputs' \
      --output table
    ;;
  release)
    : "${CLANKIE_GATEWAY_SSH_KEY:?Set CLANKIE_GATEWAY_SSH_KEY to the Lightsail private key path}"
    if [[ -n "$(git status --porcelain --untracked-files=normal)" ]]; then
      echo "Refusing to release an uncommitted gateway tree" >&2
      exit 1
    fi

    gateway_ip="${CLANKIE_GATEWAY_IP:-$(
      aws cloudformation describe-stacks \
        --region "$region" \
        --stack-name "$stack_name" \
        --query 'Stacks[0].Outputs[?OutputKey==`GatewayIp`].OutputValue | [0]' \
        --output text
    )}"
    [[ -n "$gateway_ip" && "$gateway_ip" != "None" ]] || {
      echo "The gateway stack has no static IP output" >&2
      exit 1
    }

    release_id="$(git rev-parse --short=12 HEAD)-$(date -u +%Y%m%d%H%M%S)"
    image_ref="clankie-public-gateway:$release_id"
    release_dir="$(mktemp -d -t clankie-gateway-release.XXXXXX)"
    remote_release_dir="/tmp/clankie-gateway-$release_id"
    ssh_user="${CLANKIE_GATEWAY_SSH_USER:-ec2-user}"
    ssh_target="$ssh_user@$gateway_ip"
    ssh_options=(-i "$CLANKIE_GATEWAY_SSH_KEY" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new)
    cleanup() { rm -rf -- "$release_dir"; }
    trap cleanup EXIT

    docker buildx build \
      --file apps/gateway/Dockerfile \
      --platform linux/amd64 \
      --load \
      --tag "$image_ref" \
      .
    docker save --output "$release_dir/gateway-image.tar" "$image_ref"

    ssh "${ssh_options[@]}" "$ssh_target" "sudo cloud-init status --wait >/dev/null"
    ssh "${ssh_options[@]}" "$ssh_target" "install -d -m 0700 '$remote_release_dir'"
    scp "${ssh_options[@]}" \
      "$release_dir/gateway-image.tar" \
      infra/aws/public-gateway/Caddyfile \
      "$ssh_target:$remote_release_dir/"

    ssh "${ssh_options[@]}" "$ssh_target" "bash -s -- '$remote_release_dir' '$image_ref'" <<'REMOTE'
set -euo pipefail
release_dir="$1"
image_ref="$2"
case "$release_dir" in
  /tmp/clankie-gateway-*) ;;
  *) echo "Refusing unexpected release directory: $release_dir" >&2; exit 1 ;;
esac
cleanup() { sudo rm -rf -- "$release_dir"; }
trap cleanup EXIT

secret_file=/etc/clankie-gateway/host-tokens.json
sudo test -r "$secret_file" || {
  echo "Install the root-owned host token map at $secret_file before releasing" >&2
  exit 1
}
sudo test "$(sudo stat -c %U:%G:%a "$secret_file")" = "root:clankie-gateway-secrets:640" || {
  echo "$secret_file must be root:clankie-gateway-secrets mode 0640" >&2
  exit 1
}

sudo docker load --input "$release_dir/gateway-image.tar"
sudo docker pull caddy:2.11.4-alpine
sudo install -o root -g root -m 0644 "$release_dir/Caddyfile" /opt/clankie-gateway/Caddyfile
sudo docker network inspect clankie-gateway >/dev/null 2>&1 || sudo docker network create clankie-gateway >/dev/null
sudo docker volume create clankie-caddy-data >/dev/null
sudo docker volume create clankie-caddy-config >/dev/null

start_gateway() {
  sudo docker run --detach \
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
    --env CLANKIE_GATEWAY_HOST_TOKENS_FILE=/run/secrets/host-tokens.json \
    --mount type=bind,source="$secret_file",target=/run/secrets/host-tokens.json,readonly \
    --health-cmd='node -e "fetch(\"http://127.0.0.1:8080/health\").then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"' \
    --health-interval 10s \
    --health-timeout 5s \
    --health-retries 3 \
    --health-start-period 5s \
    "$1" >/dev/null
}

previous_image="$(sudo docker inspect --format '{{.Config.Image}}' clankie-gateway 2>/dev/null || true)"
sudo docker rm --force clankie-gateway >/dev/null 2>&1 || true
start_gateway "$image_ref"
gateway_health=""
for _ in $(seq 1 30); do
  gateway_health="$(sudo docker inspect --format '{{.State.Health.Status}}' clankie-gateway)"
  [[ "$gateway_health" == "healthy" ]] && break
  sleep 1
done
if [[ "$gateway_health" != "healthy" ]]; then
  sudo docker logs --tail 100 clankie-gateway >&2 || true
  sudo docker rm --force clankie-gateway >/dev/null 2>&1 || true
  [[ -z "$previous_image" ]] || start_gateway "$previous_image"
  echo "Gateway failed its local health check; the previous image was restored when available" >&2
  exit 1
fi

sudo docker run --rm \
  --network clankie-gateway \
  --mount type=bind,source=/opt/clankie-gateway/Caddyfile,target=/etc/caddy/Caddyfile,readonly \
  caddy:2.11.4-alpine caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
sudo docker rm --force clankie-caddy >/dev/null 2>&1 || true
sudo docker run --detach \
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
  --mount type=bind,source=/opt/clankie-gateway/Caddyfile,target=/etc/caddy/Caddyfile,readonly \
  --mount type=volume,source=clankie-caddy-data,target=/data \
  --mount type=volume,source=clankie-caddy-config,target=/config \
  caddy:2.11.4-alpine >/dev/null

echo "Released $image_ref"
REMOTE
    ;;
  *)
    echo "Usage: $0 provision|release" >&2
    exit 2
    ;;
esac
