import { createPublicGateway, loadHostTokens, type PublicGatewayLogger } from "./gateway.ts";

const port = parsePort(process.env.PORT ?? "8080");
const host = process.env.CLANKIE_GATEWAY_HOST ?? "0.0.0.0";
const hostTokens = loadHostTokens();
const logger: PublicGatewayLogger = {
  info: (fields, message) => console.log(JSON.stringify({ level: "info", ...fields, message })),
  warn: (fields, message) => console.warn(JSON.stringify({ level: "warn", ...fields, message })),
};
const gateway = createPublicGateway({ hostTokens, logger });

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
