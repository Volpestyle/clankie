import { loadConfig } from "@clankie/model-provider";
import type { PiSeatModel } from "./captain/herdr-watch.ts";
import { HOSTED_DEFAULT_MODEL } from "./hosted-body.ts";

const INCLUDED_PROVIDER = "clankie";

/**
 * The model a hosted body's pi workers run on (VUH-1373), read from the
 * body's own model config at every hire so it follows the same rule as the
 * captain (96cb9f9b). On included usage (`clankie/…` selected) it is
 * `clankie/default` through the body's loopback forwarder, declared for pi
 * with no key: the forwarder signs each call and the fleet proxy holds the
 * only provider key. On the customer's own credential it is their selected
 * model. A body with no included provider declared is not hosted: undefined.
 */
export async function hostedPiSeatModel(
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<PiSeatModel | undefined> {
  const { config } = await loadConfig(options.env === undefined ? {} : { env: options.env });
  const included = config.provider?.[INCLUDED_PROVIDER];
  const baseUrl = included?.options?.baseURL;
  if (typeof baseUrl !== "string") return undefined;
  if (config.model !== undefined && !config.model.startsWith(`${INCLUDED_PROVIDER}/`)) {
    return { model: config.model };
  }
  const model = (id: string) => {
    const declared = included?.models?.[id] as { limit?: { context?: number; output?: number } } | undefined;
    return {
      id,
      name: `Clankie ${id}`,
      reasoning: true,
      input: ["text", "image"],
      contextWindow: declared?.limit?.context ?? 272_000,
      maxTokens: declared?.limit?.output ?? 8_192,
    };
  };
  return {
    model: HOSTED_DEFAULT_MODEL,
    provider: {
      id: INCLUDED_PROVIDER,
      config: {
        baseUrl,
        api: "openai-responses",
        // Pi will not use a provider it sees no auth for; the forwarder drops this.
        apiKey: "local",
        models: ["default", "routine", "escalation"].map(model),
      },
    },
  };
}
