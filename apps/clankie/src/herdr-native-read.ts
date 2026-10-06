import type { HerdrBinding } from "@clankie/protocol";
import { nativeRequest } from "./herdr-native-request.ts";

/** Exact read-only CLI projections over the existing native transport. No retry/fallback after dispatch. */
export function nativeHerdrRead(
  binding: HerdrBinding,
  args: readonly string[],
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<string> | undefined {
  let method: string;
  let params: Record<string, string>;
  if (args.length === 2 && args[0] === "agent" && args[1] === "list") {
    method = "agent.list";
    params = {};
  } else if (args.length === 3 && args[0] === "agent" && args[1] === "get") {
    method = "agent.get";
    params = { target: args[2]! };
  } else if (args.length === 2 && args[0] === "pane" && args[1] === "list") {
    method = "pane.list";
    params = {};
  } else if (args.length === 4 && args[0] === "pane" && args[1] === "process-info" && args[2] === "--pane") {
    method = "pane.process_info";
    params = { pane_id: args[3]! };
  } else if (args.length === 2 && args[0] === "api" && args[1] === "snapshot") {
    method = "session.snapshot";
    params = {};
  } else return undefined;
  return nativeRequest(binding, method, params, options).then(JSON.stringify);
}
