# Built by aws/gateway/deploy.sh from the esbuild bundle, which inlines
# @clankie/protocol from the sibling public checkout.
FROM node:24-alpine

ENV NODE_ENV=production
WORKDIR /app
COPY dist/index.cjs ./index.cjs
# Operator-only installation key reset; run with docker exec on the gateway host.
COPY dist/host-keys-cli.cjs ./host-keys-cli.cjs
USER node
EXPOSE 8080
CMD ["node", "index.cjs"]
