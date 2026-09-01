FROM node:24-alpine AS build

RUN corepack enable
WORKDIR /src

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY patches patches
COPY apps/gateway/package.json apps/gateway/package.json
COPY packages/protocol/package.json packages/protocol/package.json
RUN pnpm install --filter @clankie/gateway... --frozen-lockfile

COPY apps/gateway apps/gateway
COPY packages/protocol packages/protocol
RUN pnpm --filter @clankie/gateway build

FROM node:24-alpine

ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /src/apps/gateway/dist/index.cjs ./index.cjs
USER node
EXPOSE 8080
CMD ["node", "index.cjs"]
