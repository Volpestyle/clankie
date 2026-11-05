# Manual native-hook proof only. No host state or credentials enter this image.
FROM node:26.7.0-bookworm
WORKDIR /work
COPY source.tar /tmp/source.tar
RUN npm install --global pnpm@11.11.0 \
    && tar -xf /tmp/source.tar -C /work \
    && pnpm install --frozen-lockfile --ignore-scripts \
    && node scripts/build-herdr.mjs && node scripts/build-fleet-proof.mjs \
    && npm install --prefix /opt/claude @anthropic-ai/claude-code@2.1.318
# Owner-selected consent and native trust exist only inside this disposable fixture.
RUN mkdir -p /etc/claude-code \
    && printf '%s' '{"channelsEnabled":true,"allowedChannelPlugins":[{"marketplace":"inline","plugin":"clankie-worker"}]}' > /etc/claude-code/managed-settings.json \
    && chown -R node:node /work
ENV PATH=/opt/claude/node_modules/.bin:/work/.data/herdr/bin:/usr/local/bin:/usr/bin:/bin
ENV NODE_ENV=test VITEST=true WATCH_WORKER_NATIVE_PROOF=1 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 DISABLE_TELEMETRY=1 DISABLE_ERROR_REPORTING=1
USER node
CMD ["pnpm", "--filter", "@clankie/clankie", "exec", "tsx", "test/fixtures/watch-worker-native/journey.ts"]
