#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

stack_name="${CLANKIE_GATEWAY_STACK:-clankie-public-gateway}"
command_name="${1:-}"

gateway_target() {
  if [[ -n "${CLANKIE_GATEWAY_TARGET:-}" ]]; then
    echo "$CLANKIE_GATEWAY_TARGET"
    return
  fi
  if [[ -n "${CLANKIE_GATEWAY_IP:-}" ]]; then
    echo "$CLANKIE_GATEWAY_IP"
    return
  fi
  : "${CLANKIE_AWS_REGION:?Set CLANKIE_AWS_REGION or CLANKIE_GATEWAY_TARGET}"
  aws cloudformation describe-stacks \
    --region "$CLANKIE_AWS_REGION" \
    --stack-name "$stack_name" \
    --query 'Stacks[0].Outputs[?OutputKey==`GatewayIp`].OutputValue | [0]' \
    --output text
}

ssh_options=(-o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=15 -o StrictHostKeyChecking=accept-new)
if [[ -n "${CLANKIE_GATEWAY_SSH_KEY:-}" ]]; then
  ssh_options+=(-i "$CLANKIE_GATEWAY_SSH_KEY" -o IdentitiesOnly=yes)
fi

case "$command_name" in
  provision)
    : "${CLANKIE_AWS_REGION:?Set CLANKIE_AWS_REGION}"
    : "${CLANKIE_GATEWAY_KEY_PAIR_NAME:?Set CLANKIE_GATEWAY_KEY_PAIR_NAME}"
    public_ssh="${CLANKIE_GATEWAY_PUBLIC_SSH:-true}"
    [[ "$public_ssh" == true || "$public_ssh" == false ]] || {
      echo "CLANKIE_GATEWAY_PUBLIC_SSH must be true or false" >&2
      exit 2
    }
    if [[ "$public_ssh" == true ]]; then
      : "${CLANKIE_GATEWAY_OPERATOR_CIDR:?Set CLANKIE_GATEWAY_OPERATOR_CIDR to your public IPv4 /32}"
      operator_cidr="$CLANKIE_GATEWAY_OPERATOR_CIDR"
    else
      operator_cidr="${CLANKIE_GATEWAY_OPERATOR_CIDR:-127.0.0.1/32}"
    fi
    aws cloudformation deploy \
      --region "$CLANKIE_AWS_REGION" \
      --stack-name "$stack_name" \
      --template-file infra/aws/public-gateway/template.yaml \
      --parameter-overrides \
        "KeyPairName=$CLANKIE_GATEWAY_KEY_PAIR_NAME" \
        "OperatorCidr=$operator_cidr" \
        "PublicSshEnabled=$public_ssh"
    aws cloudformation describe-stacks \
      --region "$CLANKIE_AWS_REGION" \
      --stack-name "$stack_name" \
      --query 'Stacks[0].Outputs' \
      --output table
    ;;
  bootstrap)
    : "${CLANKIE_GATEWAY_SSH_KEY:?Set CLANKIE_GATEWAY_SSH_KEY to the Lightsail private key path}"
    target="$(gateway_target)"
    [[ -n "$target" && "$target" != None ]] || {
      echo "The gateway stack has no static IP output" >&2
      exit 1
    }
    ssh_user="${CLANKIE_GATEWAY_SSH_USER:-ec2-user}"
    ssh_target="$ssh_user@$target"
    remote_activator="/tmp/clankie-gateway-activate.$$"
    ssh "${ssh_options[@]}" "$ssh_target" "sudo cloud-init status --wait >/dev/null"
    scp "${ssh_options[@]}" infra/aws/public-gateway/activate-release.sh "$ssh_target:$remote_activator"
    ssh "${ssh_options[@]}" "$ssh_target" \
      "sudo install -o root -g root -m 0755 '$remote_activator' /usr/local/sbin/clankie-gateway-activate && rm -f '$remote_activator' && sudo /usr/local/sbin/clankie-gateway-activate --version"
    ;;
  release)
    if [[ -n "$(git status --porcelain --untracked-files=normal)" ]]; then
      echo "Refusing to release an uncommitted gateway tree" >&2
      exit 1
    fi

    target="$(gateway_target)"
    [[ -n "$target" && "$target" != None ]] || {
      echo "The gateway stack has no target" >&2
      exit 1
    }

    release_id="$(git rev-parse --short=12 HEAD)-$(date -u +%Y%m%d%H%M%S)"
    image_ref="clankie-public-gateway:$release_id"
    release_dir="$(mktemp -d -t clankie-gateway-release.XXXXXX)"
    remote_release_dir="/tmp/clankie-gateway-$release_id"
    ssh_user="${CLANKIE_GATEWAY_SSH_USER:-ec2-user}"
    ssh_target="$ssh_user@$target"
    cleanup() { rm -rf -- "$release_dir"; }
    trap cleanup EXIT

    local_version="$(infra/aws/public-gateway/activate-release.sh --version)"
    remote_version="$(ssh "${ssh_options[@]}" "$ssh_target" "sudo /usr/local/sbin/clankie-gateway-activate --version")"
    [[ "$local_version" == "$remote_version" ]] || {
      echo "Gateway activator version $remote_version does not match repository version $local_version; run bootstrap" >&2
      exit 1
    }

    docker buildx build \
      --file apps/gateway/Dockerfile \
      --platform linux/amd64 \
      --load \
      --tag "$image_ref" \
      .
    docker save --output "$release_dir/gateway-image.tar" "$image_ref"

    ssh "${ssh_options[@]}" "$ssh_target" "install -d -m 0700 '$remote_release_dir'"
    scp "${ssh_options[@]}" \
      "$release_dir/gateway-image.tar" \
      infra/aws/public-gateway/Caddyfile \
      "$ssh_target:$remote_release_dir/"
    ssh "${ssh_options[@]}" "$ssh_target" \
      "sudo /usr/local/sbin/clankie-gateway-activate '$remote_release_dir' '$image_ref'"
    ;;
  *)
    echo "Usage: $0 provision|bootstrap|release" >&2
    exit 2
    ;;
esac
