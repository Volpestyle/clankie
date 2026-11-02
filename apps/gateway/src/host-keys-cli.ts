import { isAbsolute } from "node:path";
import { PublicGatewayHostIdSchema } from "@clankie/protocol/public-gateway";
import { HostKeys } from "./host-keys.ts";

/**
 * Operator recovery for a Mac that lost its installation key: forget one host's
 * pinned key so its next proven connection pins a new one. Run on the gateway
 * host against the service's database; the network never reaches this.
 */
const usage = "Usage: host-keys-cli reset HOST_ID --database ABSOLUTE_PATH";
const [verb, hostId, flag, database] = process.argv.slice(2);
if (verb !== "reset" || flag !== "--database" || database === undefined || !isAbsolute(database)) {
  process.stderr.write(`${usage}\n`);
  process.exit(2);
}
const parsed = PublicGatewayHostIdSchema.safeParse(hostId);
if (!parsed.success) {
  process.stderr.write("HOST_ID is not a gateway host id\n");
  process.exit(2);
}
const keys = new HostKeys(database);
try {
  const removed = keys.reset(parsed.data);
  process.stdout.write(
    `${JSON.stringify({ event: "gateway.host.key_reset", hostId: parsed.data, removed, at: new Date().toISOString() })}\n`,
  );
} finally {
  keys.close();
}
