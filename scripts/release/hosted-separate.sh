#!/bin/sh
# The root half of the hosted entrypoint (VUH-2320). A launcher opts in by
# starting the container as root with exactly the capabilities this needs:
#   --user 0:0 --cap-drop ALL --cap-add CHOWN --cap-add DAC_OVERRIDE
#   --cap-add FOWNER --cap-add SETPCAP --cap-add SETUID --cap-add SETGID
#   --security-opt no-new-privileges
# It prepares the agent's directories once, then runs the body as the service
# (`node`) with only SETUID and SETGID, which it uses solely to start
# model-directed work as `clankie-agent` with no capabilities at all. The agent
# cannot write the service's state or switch back. Without no-new-privileges a
# setuid binary could regain capabilities, so separation refuses to start.
set -eu
umask 077
fail() {
  echo "clankie: agent separation: $1" >&2
  exit 1
}
grep -q '^NoNewPrivs:[[:space:]]*1$' /proc/self/status || fail "start the container with --security-opt no-new-privileges"
agent_uid=$(id -u clankie-agent) || fail "the image has no clankie-agent user"
agent_gid=$(id -g clankie-agent)
workspace_gid=$(getent group clankie-workspace | cut -d: -f3)
[ -n "$workspace_gid" ] || fail "the image has no clankie-workspace group"

# The service owns /state. The agent may traverse it to reach the release it
# runs and its own home, and nothing else: every other top-level entry loses
# group and other access, which blocks everything below it.
mkdir -p /state /workspace
chown node:node /state
chmod 0711 /state
for entry in /state/* /state/.[!.]*; do
  [ -e "$entry" ] || [ -L "$entry" ] || continue
  case "$entry" in
    /state/install | /state/agent) ;;
    *) chmod go-rwx "$entry" ;;
  esac
done
# The release the service runs is also the code the agent runs: readable and
# executable by everyone, writable only by the service. Releases it installs
# later inherit the shared group from these setgid directories.
if [ -d /state/install ]; then
  chown -R node:clankie-workspace /state/install
  chmod -R go+rX,go-w /state/install
  find /state/install -type d -exec chmod g+s {} +
fi
# The agent's own home: its shell history, tool caches and git identity.
if [ ! -d /state/agent ]; then
  mkdir /state/agent
fi
chown clankie-agent:clankie-agent /state/agent
chmod 0700 /state/agent
if [ ! -e /state/agent/.gitconfig ]; then
  # Repositories under /workspace may belong to workers; the agent may use them.
  printf '[safe]\n\tdirectory = /workspace/*\n' >/state/agent/.gitconfig
  chown clankie-agent:clankie-agent /state/agent/.gitconfig
fi
# /workspace is shared work: the agent and the service's workers both read and
# write it through the clankie-workspace group. The first separated start
# brings existing work into that group.
if [ ! -e /state/.agent-separation-v1 ]; then
  chgrp -R clankie-workspace /workspace
  chmod -R g+rwX /workspace
  find /workspace -type d -exec chmod g+s {} +
  : >/state/.agent-separation-v1
  chown node:node /state/.agent-separation-v1
fi
chgrp clankie-workspace /workspace
chmod 2770 /workspace

export CLANKIE_AGENT_UID="$agent_uid" CLANKIE_AGENT_GID="$agent_gid"
export CLANKIE_AGENT_GROUPS="$workspace_gid" CLANKIE_AGENT_HOME=/state/agent
exec /usr/bin/setpriv --reuid=node --regid=node --init-groups \
  --inh-caps=-all,+setuid,+setgid --ambient-caps=-all,+setuid,+setgid \
  --bounding-set=-all,+setuid,+setgid -- clankie-hosted "$@"
