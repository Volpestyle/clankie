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
RUN node scripts/build-release.mjs --hosted

FROM node:24.20.0-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git openssh-client procps lsof ripgrep curl \
 && rm -rf /var/lib/apt/lists/*
# The documented npm distribution installs the native platform binary and license.
RUN npm install --global @anthropic-ai/claude-code@2.1.281 && npm cache clean --force
# pi is a hireable harness, so it must be on PATH like claude; keep the workspace's pin.
RUN npm install --global @earendil-works/pi-coding-agent@0.84.2 && npm cache clean --force
COPY --from=build /clankie/dist/hosted /opt/clankie
COPY --chmod=755 scripts/release/hosted-entrypoint.sh /usr/local/bin/clankie-hosted
COPY --chmod=755 scripts/release/hosted-body.sh /usr/local/bin/clankie-body
RUN printf '#!/bin/sh\nexec node /opt/clankie/apps/tui/bin/clankie.js "$@"\n' > /usr/local/bin/clankie \
 && chmod 755 /usr/local/bin/clankie \
 && mkdir -p /state/home /state/config /state/runtime /workspace \
 && chown -R node:node /state /workspace
ENV HOME=/state/home \
    SHELL=/bin/bash \
    CLANKIE_INSTALL_ROOT=/opt/clankie \
    CLANKIE_LAUNCHER_PATH=/usr/local/bin/clankie \
    CLANKIE_STATE=/state/runtime \
    XDG_CONFIG_HOME=/state/config \
    XDG_STATE_HOME=/state/history \
    CLANKIE_CREDENTIALS_FILE=/state/credentials.json \
    CLANKIE_DISCORD_PRESENCE_RUNTIME_MODULE=/opt/clankie/apps/discord-bridge/src/presence-runtime-module.js \
    CLANKIE_DISCORD_USER_PRESENCE_RUNTIME_MODULE=/opt/clankie/apps/discord-user-session/src/presence-runtime-module.js \
    CLANKIE_BROWSER_ENABLED=false \
    CLANKIE_TLDRAW_ENABLED=false \
    CLANKIE_SERVICES=clankie,relay \
    DISABLE_AUTOUPDATER=1
ENV PATH=/opt/clankie/libexec:$PATH
USER node
WORKDIR /workspace
ENTRYPOINT ["clankie-hosted"]
CMD ["node", "/opt/clankie/apps/clankie/src/index.js"]
HEALTHCHECK --interval=15s --timeout=5s --start-period=90s \
 CMD node -e 'fetch("http://127.0.0.1:4310/health").then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))'
