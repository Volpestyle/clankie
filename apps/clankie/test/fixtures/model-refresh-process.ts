/** One service process: a real Pi runtime over the shared file broker resolves an expired OAuth token. */
import { createInterface } from "node:readline";
import { FileCredentialStore } from "@clankie/credential-broker";
import type { Api } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { BrokerCredentialStore } from "../../src/captain/model.ts";

const input = JSON.parse(process.argv[2] ?? "{}") as { path: string; tokenUrl: string };
const runtime = await ModelRuntime.create({
  credentials: new BrokerCredentialStore(new FileCredentialStore(input.path)),
  modelsPath: null,
  refreshOnCreate: false,
});
runtime.registerProvider("token-provider", {
  api: "openai-completions" as Api,
  baseUrl: "http://127.0.0.1:9/v1",
  oauth: {
    name: "Token provider",
    login: async () => {
      throw new Error("Interactive login is not part of this test");
    },
    refreshToken: async (current, signal) => {
      const response = await fetch(input.tokenUrl, {
        method: "POST",
        body: JSON.stringify({ refresh: current.refresh }),
        signal,
      });
      if (!response.ok) throw new Error(`token endpoint answered ${String(response.status)}`);
      const token = (await response.json()) as { access: string; refresh: string; expiresIn: number };
      return { access: token.access, refresh: token.refresh, expires: Date.now() + token.expiresIn * 1_000 };
    },
    getApiKey: (current) => current.access,
  },
  models: [
    {
      id: "token-model",
      name: "token-model",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 100_000,
      maxTokens: 1_000,
    },
  ],
});
// Both processes resolve together once the parent releases them.
process.stdout.write("ready\n");
const lines = createInterface({ input: process.stdin });
for await (const _line of lines) break;
lines.close();
const auth = await runtime.getAuth("token-provider");
process.stdout.write(`${auth?.auth.apiKey ?? "none"}\n`);
