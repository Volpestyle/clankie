import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  ACCOUNTS_PATH,
  ACCOUNT_DISCONNECT_PATH,
  ACCOUNT_GITHUB_POLL_PATH,
  ACCOUNT_GITHUB_START_PATH,
  ACCOUNT_LINEAR_COMPLETE_PATH,
  ACCOUNT_LINEAR_START_PATH,
  AccountDisconnectRequestSchema,
  AccountDisconnectResultSchema,
  AccountGithubPollRequestSchema,
  AccountGithubPollResultSchema,
  AccountGithubStartResultSchema,
  AccountLinearCompleteRequestSchema,
  AccountLinearCompleteResultSchema,
  AccountLinearStartResultSchema,
  AccountsResponseSchema,
} from "@clankie/protocol/accounts";
import type { AccountsPort } from "./accounts.ts";

/** Write-only like model keys (ADR 0196): no request, token or provider-error logging, ever. */
export function createAccountRoutes(
  accounts: AccountsPort | undefined,
  authorize: (request: Request) => Promise<true | "authentication_required" | "forbidden">,
): Hono {
  const app = new Hono();
  const paths = [
    ACCOUNTS_PATH,
    ACCOUNT_GITHUB_START_PATH,
    ACCOUNT_GITHUB_POLL_PATH,
    ACCOUNT_LINEAR_START_PATH,
    ACCOUNT_LINEAR_COMPLETE_PATH,
    ACCOUNT_DISCONNECT_PATH,
  ];
  for (const path of paths) {
    app.use(path, async (context, next) => {
      context.header("cache-control", "no-store");
      try {
        const authority = await authorize(context.req.raw);
        if (authority !== true)
          return context.json({ ok: false, error: authority }, authority === "forbidden" ? 403 : 401);
        if (accounts === undefined) return context.json({ ok: false, error: "unavailable" }, 503);
        await next();
      } catch {
        return context.json({ ok: false, error: "unavailable" }, 503);
      }
    });
    app.use(
      path,
      bodyLimit({
        maxSize: 16 * 1024,
        onError: (context) => context.json({ ok: false, error: "malformed" }, 413),
      }),
    );
  }
  app.get(ACCOUNTS_PATH, async (context) => {
    try {
      return context.json(AccountsResponseSchema.parse(await accounts!.list()));
    } catch {
      return context.json({ ok: false, error: "unavailable" }, 503);
    }
  });
  const post = (path: string, handle: (body: unknown) => Promise<{ ok: boolean }>) =>
    app.post(path, async (context) => {
      try {
        const safe = await handle(await context.req.json().catch(() => ({})));
        return context.json(safe, safe.ok ? 200 : 400);
      } catch {
        // Broker and provider failures may carry a token. Never forward or log them.
        return context.json({ ok: false, error: "unavailable" }, 503);
      }
    });
  const malformed = { ok: false, error: "malformed" } as const;
  post(ACCOUNT_GITHUB_START_PATH, async () =>
    AccountGithubStartResultSchema.parse(await accounts!.startGithub()),
  );
  post(ACCOUNT_GITHUB_POLL_PATH, async (body) => {
    const parsed = AccountGithubPollRequestSchema.safeParse(body);
    return parsed.success
      ? AccountGithubPollResultSchema.parse(await accounts!.pollGithub(parsed.data.flowId))
      : malformed;
  });
  post(ACCOUNT_LINEAR_START_PATH, async () =>
    AccountLinearStartResultSchema.parse(await accounts!.startLinear()),
  );
  post(ACCOUNT_LINEAR_COMPLETE_PATH, async (body) => {
    const parsed = AccountLinearCompleteRequestSchema.safeParse(body);
    return parsed.success
      ? AccountLinearCompleteResultSchema.parse(
          await accounts!.completeLinear(parsed.data.state, parsed.data.code),
        )
      : malformed;
  });
  post(ACCOUNT_DISCONNECT_PATH, async (body) => {
    const parsed = AccountDisconnectRequestSchema.safeParse(body);
    return parsed.success
      ? AccountDisconnectResultSchema.parse(await accounts!.disconnect(parsed.data.provider))
      : malformed;
  });
  return app;
}
