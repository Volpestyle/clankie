/**
 * Resolves the sibling app checkout and this repository's own packages. The app
 * root is the runner's choice: `CLANKIE_APP_ROOT`, defaulting to the sibling
 * `clankie-app` the app's own README documents.
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const flows = dirname(fileURLToPath(import.meta.url));
const repo = resolve(flows, "../../../..");
const appRoot = resolve(process.env.CLANKIE_APP_ROOT ?? resolve(repo, "../clankie-app"));
if (!existsSync(resolve(appRoot, "apps/mobile/pushDelivery.ts"))) {
  throw new Error(`No app checkout at ${appRoot}. Set CLANKIE_APP_ROOT to a clankie-app checkout.`);
}
// `ws` belongs to the gateway package, so ask that package for it rather than
// assuming a hoisted layout.
const require = createRequire(resolve(repo, "apps/gateway/package.json"));

export default {
  resolve: {
    alias: {
      "@app/pushDelivery": resolve(appRoot, "apps/mobile/pushDelivery.ts"),
      "@gateway/gateway": resolve(repo, "apps/gateway/src/gateway.ts"),
      "@gateway/push-registrations": resolve(repo, "apps/gateway/src/push-registrations.ts"),
      "@gateway/apns": resolve(repo, "apps/gateway/src/apns.ts"),
      "@clankie/protocol/public-gateway": resolve(repo, "packages/protocol/src/public-gateway.ts"),
      "@clankie/protocol": resolve(repo, "packages/protocol/src/index.ts"),
      ws: require.resolve("ws"),
    },
  },
  root: repo,
  test: {
    include: [resolve(flows, "boundary.test.ts")],
    fileParallelism: false,
    pool: "threads",
    testTimeout: 30000,
    hookTimeout: 30000,
  },
};
