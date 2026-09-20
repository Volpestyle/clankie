# Runtime integration proof; this image is not the hosted Clankie service image.
FROM node:26.7.0-bookworm
WORKDIR /clankie
COPY scripts/build-herdr.mjs scripts/build-herdr.mjs
COPY scripts/release/herdr.json scripts/release/herdr.json
COPY apps/clankie/src/herdr-release.ts apps/clankie/src/herdr-release.ts
RUN node scripts/build-herdr.mjs
COPY apps/clankie/src/herdr-runtime.ts apps/clankie/src/herdr-runtime.ts
COPY apps/clankie/src/herdr-binary.ts apps/clankie/src/herdr-binary.ts
COPY scripts/smoke-herdr.mjs scripts/smoke-herdr.mjs
CMD ["node", "scripts/smoke-herdr.mjs"]
