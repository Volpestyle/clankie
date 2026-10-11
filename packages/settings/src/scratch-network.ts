import { homedir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { verifiedLocalSandbox } from "./local-sandbox.ts";

/** Refuse before credentials, listeners or upstream requests are created. */
export function assertScratchNetwork(
  service: "clankie" | "relay",
  env: NodeJS.ProcessEnv = process.env,
): void {
  const sandbox = verifiedLocalSandbox();
  const liveState = sandbox ? join(sandbox.home, "s") : join(userInfo().homedir, ".clankie");
  const state = resolve(env.CLANKIE_STATE?.trim() || join(homedir(), ".clankie"));
  const scratch =
    env.CLANKIE_SCRATCH === "1" || env.NODE_ENV === "development" || state !== resolve(liveState);
  if (!scratch) return;
  const reject = (name: string, value: string) => {
    throw new Error(`scratch_live_port_refused: ${name}=${value}; use scripts/scratch-stack.mjs`);
  };
  const port = (name: string, value: string) => {
    const number = Number(value);
    if (!Number.isInteger(number) || number < 0 || number > 65535 || number === 4310 || number === 4321)
      reject(name, value);
  };
  const url = (name: string, value: string) => {
    const parsed = new URL(value);
    port(name, parsed.port || (parsed.protocol === "https:" ? "443" : "80"));
  };
  port(
    "CLANKIE_RELAY_PORT",
    env.CLANKIE_RELAY_PORT ?? (service === "relay" ? env.PORT : undefined) ?? "4321",
  );
  if (service === "clankie") {
    if (Number(env.CLANKIE_RELAY_PORT ?? "4321") === 0) reject("CLANKIE_RELAY_PORT", "0");
    port("PORT", env.PORT ?? "4310");
    if (env.CLANKIE_RELAY_URL) url("CLANKIE_RELAY_URL", env.CLANKIE_RELAY_URL);
    if (env.CLANKIE_DIRECT_CONTROL_PLANE_URL)
      url("CLANKIE_DIRECT_CONTROL_PLANE_URL", env.CLANKIE_DIRECT_CONTROL_PLANE_URL);
    if (env.CLANKIE_DEVICE_HOST && env.CLANKIE_DEVICE_PORT)
      port("CLANKIE_DEVICE_PORT", env.CLANKIE_DEVICE_PORT);
  } else {
    url("CLANKIE_CAPTAIN_URL", env.CLANKIE_CAPTAIN_URL ?? "http://127.0.0.1:4310");
    url("CLANKIE_CONTROL_PLANE_URL", env.CLANKIE_CONTROL_PLANE_URL ?? "http://127.0.0.1:4310");
  }
}
