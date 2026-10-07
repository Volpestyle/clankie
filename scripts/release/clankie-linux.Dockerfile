# One owner's hosted captain and worker environment. No owner files enter the build.
FROM rust:1.96.1-bookworm AS rust
FROM node:24.20.0-bookworm AS build
COPY --from=rust /usr/local/cargo /usr/local/cargo
COPY --from=rust /usr/local/rustup /usr/local/rustup
ENV CARGO_HOME=/usr/local/cargo RUSTUP_HOME=/usr/local/rustup
ENV PATH=/usr/local/cargo/bin:$PATH
RUN corepack enable && corepack prepare pnpm@11.11.0 --activate
WORKDIR /clankie
COPY . .
RUN pnpm install --frozen-lockfile
# Cargo supplies the locked Herdr license inventory; no native compiler is shipped.
# The revision makes the seed an updatable official release (the build has no .git).
ARG CLANKIE_REVISION
RUN CLANKIE_REVISION="${CLANKIE_REVISION:-source-checkout}" node scripts/build-release.mjs --hosted

FROM node:24.20.0-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git openssh-client procps lsof ripgrep curl python3 \
 && rm -rf /var/lib/apt/lists/*
# The documented npm distribution installs the native platform binary and license.
RUN npm install --global @anthropic-ai/claude-code@2.1.281 && npm cache clean --force
# pi is a hireable harness, so it must be on PATH like claude; keep the workspace's pin.
RUN npm install --global @earendil-works/pi-coding-agent@0.84.2 && npm cache clean --force
COPY --from=build /clankie/dist/hosted /opt/clankie
COPY --chmod=755 scripts/release/hosted-entrypoint.sh /usr/local/bin/clankie-hosted
COPY --chmod=755 scripts/release/hosted-body.sh /usr/local/bin/clankie-body
COPY --chmod=755 scripts/release/hosted-release-root.sh /usr/local/bin/clankie-release-root
COPY --chmod=755 scripts/release/hosted-claude-worker.sh /usr/local/bin/clankie-claude-worker
# The image builder is this machine's administrator: approve the Claude worker
# channel that hires enable per session, so hosted hires need no owner step (VUH-1767).
RUN mkdir -p /etc/claude-code \
 && printf '%s\n' '{"channelsEnabled":true,"allowedChannelPlugins":[{"marketplace":"clankie","plugin":"clankie-worker"}]}' \
    > /etc/claude-code/managed-settings.json \
 && chmod 644 /etc/claude-code/managed-settings.json
# /opt/clankie is the seed; the body runs and updates /state/install/current (ADR 0237).
RUN printf '#!/bin/sh\n[ -x /state/install/current/bin/clankie ] && exec /state/install/current/bin/clankie "$@"\nexec /opt/clankie/bin/clankie "$@"\n' > /usr/local/bin/clankie \
 && chmod 755 /usr/local/bin/clankie \
 && mkdir -p /state/home /state/config /state/runtime /workspace \
 && chown -R node:node /state /workspace
ENV HOME=/state/home \
    SHELL=/bin/bash \
    CLANKIE_LAUNCHER_PATH=/usr/local/bin/clankie \
    CLANKIE_STATE=/state/runtime \
    XDG_CONFIG_HOME=/state/config \
    XDG_STATE_HOME=/state/history \
    CLANKIE_CREDENTIALS_FILE=/state/credentials.json \
    CLANKIE_DISCORD_PRESENCE_RUNTIME_MODULE=/state/install/current/apps/discord-bridge/src/presence-runtime-module.js \
    CLANKIE_DISCORD_USER_PRESENCE_RUNTIME_MODULE=/state/install/current/apps/discord-user-session/src/presence-runtime-module.js \
    CLANKIE_BROWSER_ENABLED=false \
    CLANKIE_TLDRAW_ENABLED=false \
    CLANKIE_SERVICES=clankie,relay \
    CLANKIE_SCHEDULED_UPDATES=1 \
    DISABLE_AUTOUPDATER=1
ENV PATH=/state/install/current/libexec:/opt/clankie/libexec:$PATH
USER node
WORKDIR /workspace
# Import from the relocated release as the runtime user. The browser's package
# graph must load even when browsing is disabled, since the service imports it.
RUN cd /opt/clankie && node --input-type=module -e 'await import("@browser_use/pi")'
# Verify as the actual runtime user, without an owner's global skill installation.
RUN test "$(herdr --version)" = "herdr $(node -p 'require("/opt/clankie/release.json").herdr.release.version')" \
 && herdr --skill > /tmp/herdr-skill \
 && cmp /tmp/herdr-skill /opt/clankie/.agents/skills/herdr/SKILL.md \
 && cmp /tmp/herdr-skill /opt/clankie/integrations/claude-plugin/skills/herdr/SKILL.md \
 && cmp /tmp/herdr-skill /opt/clankie/integrations/worker-skills/skills/herdr/SKILL.md \
 && rm /tmp/herdr-skill
ENTRYPOINT ["clankie-hosted"]
# The whole body under the launcher, so an update can stop and restart its services.
CMD ["clankie-body"]
HEALTHCHECK --interval=15s --timeout=5s --start-period=90s \
 CMD node -e 'fetch("http://127.0.0.1:4310/health").then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))'
