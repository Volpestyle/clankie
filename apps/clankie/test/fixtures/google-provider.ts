import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { AccountGoogleStartResult, GoogleAccountProvider } from "@clankie/protocol/accounts";
import { GOOGLE_ACCOUNT_DEFINITIONS, type GoogleOAuthEndpoints } from "@clankie/credential-broker";

interface FixtureIdentity {
  subject: string;
  email: string;
}
interface CodeOptions extends FixtureIdentity {
  clientId?: string;
  claims?: Record<string, unknown>;
  scopes?: string;
  omitRefresh?: boolean;
  invalidSignature?: boolean;
  omitIdToken?: boolean;
}
interface Grant extends FixtureIdentity {
  clientId: string;
  scopes: string;
  access: string;
  refresh: string;
}
export interface GoogleFixtureRequest {
  path: string;
  method: string;
  authorization?: string;
  body: string;
}
/** Actual HTTP OAuth + RSA-signed OIDC + read-only MCP fixture; no Google account. */
export async function createGoogleProviderFixture() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "fixture-key", alg: "RS256", use: "sig" };
  const clients = new Map<string, string>();
  const codes = new Map<
    string,
    { options: CodeOptions; nonce: string; challenge: string; redirectUri: string; requested: string }
  >();
  const accesses = new Map<string, Grant>();
  const refreshes = new Map<string, Grant>();
  const seen: GoogleFixtureRequest[] = [];
  const controls: {
    toolResults?: Record<string, { value: unknown; isError?: boolean }>;
    revokeStatus: number;
    refreshStatus: number;
    refreshError: string;
    rotateRefresh: boolean;
    omitRefreshScope: boolean;
    refreshScope?: string;
    refreshGate?: Promise<void>;
    refreshStarted?: () => void;
    callGate?: Promise<void>;
    callStarted?: () => void;
  } = {
    revokeStatus: 200,
    refreshStatus: 200,
    refreshError: "invalid_grant",
    rotateRefresh: false,
    omitRefreshScope: false,
  };
  const jwt = (claims: Record<string, unknown>, invalidSignature = false) => {
    const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "fixture-key" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const data = `${header}.${payload}`;
    const signature = sign("RSA-SHA256", Buffer.from(data), privateKey);
    if (invalidSignature) signature[0] = signature[0]! ^ 0xff;
    return `${data}.${signature.toString("base64url")}`;
  };
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request)
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
      const body = Buffer.concat(chunks).toString("utf8");
      const path = new URL(request.url ?? "/", "http://fixture").pathname;
      seen.push({
        path,
        method: request.method ?? "",
        ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}),
        body,
      });
      const json = (status: number, value: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(value));
      };
      if (path === "/jwks") return json(200, { keys: [jwk] });
      const form = new URLSearchParams(body);
      if (path === "/token" && form.get("grant_type") === "authorization_code") {
        const code = form.get("code") ?? "";
        const pending = codes.get(code);
        codes.delete(code);
        if (
          !pending ||
          pending.options.clientId !== form.get("client_id") ||
          clients.get(pending.options.clientId!) !== form.get("client_secret") ||
          pending.redirectUri !== form.get("redirect_uri") ||
          createHash("sha256")
            .update(form.get("code_verifier") ?? "")
            .digest("base64url") !== pending.challenge
        )
          return json(400, { error: "invalid_grant" });
        const options = pending.options;
        const grant: Grant = {
          subject: options.subject,
          email: options.email,
          clientId: options.clientId!,
          scopes: options.scopes ?? pending.requested,
          access: `access-${randomUUID()}`,
          refresh: `refresh-${randomUUID()}`,
        };
        accesses.set(grant.access, grant);
        refreshes.set(grant.refresh, grant);
        return json(200, {
          access_token: grant.access,
          ...(options.omitRefresh ? {} : { refresh_token: grant.refresh }),
          expires_in: 3600,
          token_type: "Bearer",
          scope: grant.scopes,
          ...(options.omitIdToken || !grant.scopes.split(" ").includes("openid")
            ? {}
            : {
                id_token: jwt(
                  {
                    iss: "https://accounts.google.com",
                    aud: grant.clientId,
                    sub: grant.subject,
                    email: grant.email,
                    email_verified: true,
                    nonce: pending.nonce,
                    exp: Math.floor(Date.now() / 1000) + 3600,
                    iat: Math.floor(Date.now() / 1000),
                    ...options.claims,
                  },
                  options.invalidSignature,
                ),
              }),
        });
      }
      if (path === "/token" && form.get("grant_type") === "refresh_token") {
        controls.refreshStarted?.();
        await controls.refreshGate;
        if (controls.refreshStatus !== 200)
          return json(controls.refreshStatus, {
            error: controls.refreshError,
            error_description: "Never forward provider text",
          });
        const grant = refreshes.get(form.get("refresh_token") ?? "");
        if (
          !grant ||
          grant.clientId !== form.get("client_id") ||
          clients.get(grant.clientId) !== form.get("client_secret")
        )
          return json(400, { error: "invalid_grant" });
        const next = {
          ...grant,
          access: `access-${randomUUID()}`,
          ...(controls.rotateRefresh ? { refresh: `refresh-${randomUUID()}` } : {}),
        };
        accesses.set(next.access, next);
        refreshes.set(next.refresh, next);
        if (controls.rotateRefresh) refreshes.delete(grant.refresh);
        return json(200, {
          access_token: next.access,
          token_type: "Bearer",
          expires_in: 3600,
          ...(controls.rotateRefresh ? { refresh_token: next.refresh } : {}),
          ...(controls.omitRefreshScope ? {} : { scope: controls.refreshScope ?? grant.scopes }),
        });
      }
      if (path === "/revoke") {
        if (controls.revokeStatus === 200) {
          const grant = refreshes.get(form.get("token") ?? "") ?? accesses.get(form.get("token") ?? "");
          if (grant) {
            for (const [key, candidate] of refreshes)
              if (candidate.subject === grant.subject && candidate.clientId === grant.clientId)
                refreshes.delete(key);
            for (const [key, candidate] of accesses)
              if (candidate.subject === grant.subject && candidate.clientId === grant.clientId)
                accesses.delete(key);
          }
        }
        return json(controls.revokeStatus, {});
      }
      if (path === "/drive/about") {
        const grant = accesses.get((request.headers.authorization ?? "").replace(/^Bearer /u, ""));
        if (!grant) return json(401, {});
        return json(200, {
          user: { permissionId: `permission-${grant.subject}`, emailAddress: grant.email },
        });
      }
      const provider = (
        {
          "/gmail/mcp": "google-gmail",
          "/calendar/mcp": "google-calendar",
          "/drive/mcp": "google-drive",
        } as const
      )[path as "/gmail/mcp"];
      if (provider && request.method === "POST") return await mcp(request, body, provider, json);
      if (provider && request.method === "DELETE") {
        response.writeHead(200);
        response.end();
        return;
      }
      return json(404, {});
    })().catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  async function mcp(
    request: IncomingMessage,
    body: string,
    provider: GoogleAccountProvider,
    json: (status: number, value: unknown) => void,
  ) {
    const grant = accesses.get((request.headers.authorization ?? "").replace(/^Bearer /u, ""));
    if (!grant || !grant.scopes.includes(GOOGLE_ACCOUNT_DEFINITIONS[provider].scope))
      return json(401, { error: "unauthorized" });
    const rpc = JSON.parse(body) as {
      id?: string | number;
      method: string;
      params?: { name?: string; arguments?: Record<string, unknown> };
    };
    if (rpc.method === "notifications/initialized") return json(202, {});
    if (rpc.method === "initialize")
      return json(200, {
        jsonrpc: "2.0",
        id: rpc.id,
        result: {
          protocolVersion: "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "Google HTTP fixture", version: "1" },
        },
      });
    if (rpc.method === "tools/list")
      return json(200, {
        jsonrpc: "2.0",
        id: rpc.id,
        result: {
          tools: [...GOOGLE_ACCOUNT_DEFINITIONS[provider].tools, "delete_everything"].map((name) => ({
            name,
            description: "Read fixture",
            inputSchema: { type: "object", properties: {} },
          })),
        },
      });
    if (rpc.method === "tools/call") {
      controls.callStarted?.();
      await controls.callGate;
      const override = controls.toolResults?.[`${provider}:${rpc.params?.name}`];
      if (override !== undefined)
        return json(200, {
          jsonrpc: "2.0",
          id: rpc.id,
          result: {
            content: [{ type: "text", text: JSON.stringify(override.value) }],
            ...(override.isError === undefined ? {} : { isError: override.isError }),
          },
        });
      return json(200, {
        jsonrpc: "2.0",
        id: rpc.id,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                subject: grant.subject,
                email: grant.email,
                tool: rpc.params?.name,
                sourceUrl:
                  provider === "google-gmail"
                    ? "https://mail.google.com/mail/u/0/#inbox/fixture"
                    : provider === "google-calendar"
                      ? "https://calendar.google.com/calendar/event?eid=fixture"
                      : "https://drive.google.com/file/d/fixture/view",
                fixture: true,
              }),
            },
          ],
        },
      });
    }
    return json(400, {});
  }
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture did not bind");
  const origin = `http://127.0.0.1:${address.port}`;
  const endpoints: GoogleOAuthEndpoints = {
    authorize: `${origin}/authorize`,
    token: `${origin}/token`,
    revoke: `${origin}/revoke`,
    jwks: `${origin}/jwks`,
    driveAbout: `${origin}/drive/about?fields=user(permissionId,emailAddress)`,
  };
  return {
    origin,
    endpoints,
    seen,
    controls,
    mcpEndpoints: {
      "google-gmail": `${origin}/gmail/mcp`,
      "google-calendar": `${origin}/calendar/mcp`,
      "google-drive": `${origin}/drive/mcp`,
    },
    addClient(clientId: string, clientSecret: string) {
      clients.set(clientId, clientSecret);
    },
    issueCode(start: AccountGoogleStartResult, options: CodeOptions): string {
      if (!start.ok) throw new Error("Start failed");
      const url = new URL(start.authorizeUrl);
      const code = `code-${randomUUID()}`;
      codes.set(code, {
        options: { ...options, clientId: options.clientId ?? url.searchParams.get("client_id")! },
        nonce: url.searchParams.get("nonce")!,
        challenge: url.searchParams.get("code_challenge")!,
        redirectUri: start.redirectUri,
        requested: url.searchParams.get("scope")!,
      });
      return code;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}
