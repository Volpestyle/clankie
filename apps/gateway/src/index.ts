import { readFileSync } from "node:fs";
import { PublicGatewayConfigSchema } from "@clankie/protocol/public-gateway";
import { trustedProxyByName } from "./client-address.ts";
import { createCognitoAccessTokenVerifier } from "./cognito-jwt.ts";
import { createPublicGateway, loadHostTokens, type PublicGatewayLogger } from "./gateway.ts";
import { createGatewayPush, loadGatewayPushConfig } from "./push-config.ts";

const port = parsePort(process.env.PORT ?? "8080");
const host = process.env.CLANKIE_GATEWAY_HOST ?? "0.0.0.0";
const hostTokens = loadHostTokens();
const accountConfig = loadAccountConfig();
const logger: PublicGatewayLogger = {
  info: (fields, message) => console.log(JSON.stringify({ level: "info", ...fields, message })),
  warn: (fields, message) => console.warn(JSON.stringify({ level: "warn", ...fields, message })),
};
// Hosted Clankie (the fleet beside the gateway) is gone. A host still configured
// for it must be decommissioned first, so its settings fail loudly here instead
// of being ignored.
const fleetSettings = Object.keys(process.env).filter((name) => name.startsWith("CLANKIE_GATEWAY_FLEET_"));
if (fleetSettings.length > 0) {
  throw new Error(
    `Hosted fleet support was removed from the gateway; unset ${fleetSettings.sort().join(", ")}`,
  );
}
if (hostTokens.size === 0 && accountConfig === undefined) {
  throw new Error("Configure Cognito account discovery or at least one legacy gateway host credential");
}
// Optional: an unconfigured gateway boots exactly as before and answers wakes
// `unavailable`. A configured one fails loudly rather than dropping them.
const push = createGatewayPush(loadGatewayPushConfig());
// The reverse proxy in front (the Caddy container's name, set by the activator).
// Without it, budgets key on the socket peer, as before.
const trustedProxyName = process.env.CLANKIE_GATEWAY_TRUSTED_PROXY?.trim();
const trustedProxy =
  trustedProxyName === undefined || trustedProxyName.length === 0
    ? undefined
    : trustedProxyByName(trustedProxyName);
const gateway = createPublicGateway({
  hostTokens,
  ...(accountConfig === undefined
    ? {}
    : {
        accountConfig,
        authenticateAccountToken: createCognitoAccessTokenVerifier({
          issuer: accountConfig.account.issuer,
          clientId: accountConfig.account.clientId,
        }),
      }),
  ...(push === undefined ? {} : { push: { registrations: push.registrations, sender: push.sender } }),
  ...(trustedProxy === undefined ? {} : { trustedProxy }),
  logger,
});

gateway.server.listen(port, host, () => {
  logger.info({ host, port, push: push !== undefined }, "public gateway listening");
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    // This module opened the push dependencies, so this module closes them —
    // after the gateway stops handing them work.
    void gateway
      .close()
      .then(async () => await push?.close())
      .finally(() => process.exit(0));
  });
}

function parsePort(raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65_535)
    throw new Error("PORT must be a valid TCP port");
  return value;
}

function loadAccountConfig() {
  const file = process.env.CLANKIE_GATEWAY_ACCOUNT_CONFIG_FILE?.trim();
  const inline = process.env.CLANKIE_GATEWAY_ACCOUNT_CONFIG_JSON?.trim();
  if (file !== undefined && file.length > 0 && inline !== undefined && inline.length > 0) {
    throw new Error("Configure the gateway account by file or JSON, not both");
  }
  const raw = file === undefined || file.length === 0 ? inline : readFileSync(file, "utf8");
  if (raw === undefined || raw.length === 0) return undefined;
  return PublicGatewayConfigSchema.parse(JSON.parse(raw));
}
