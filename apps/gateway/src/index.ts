import { readFileSync } from "node:fs";
import { PublicGatewayConfigSchema } from "@clankie/protocol";
import { createCognitoAccessTokenVerifier } from "./cognito-jwt.ts";
import { createPublicGateway, loadHostTokens, type PublicGatewayLogger } from "./gateway.ts";

const port = parsePort(process.env.PORT ?? "8080");
const host = process.env.CLANKIE_GATEWAY_HOST ?? "0.0.0.0";
const hostTokens = loadHostTokens();
const accountConfig = loadAccountConfig();
const logger: PublicGatewayLogger = {
  info: (fields, message) => console.log(JSON.stringify({ level: "info", ...fields, message })),
  warn: (fields, message) => console.warn(JSON.stringify({ level: "warn", ...fields, message })),
};
if (hostTokens.size === 0 && accountConfig === undefined) {
  throw new Error("Configure Cognito account discovery or at least one legacy gateway host credential");
}
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
  logger,
});

gateway.server.listen(port, host, () => {
  logger.info({ host, port }, "public gateway listening");
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    void gateway.close().finally(() => process.exit(0));
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
