# Built by aws/gateway/deploy.sh from the esbuild bundle, which inlines
# @clankie/protocol from the sibling public checkout.
FROM node:24-alpine

ENV NODE_ENV=production
WORKDIR /app
COPY dist/index.cjs ./index.cjs
USER node
EXPOSE 8080
CMD ["node", "index.cjs"]
