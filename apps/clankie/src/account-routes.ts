import { z } from "zod";
import {
  codexAccounts,
  readCodexAccountStatus,
  registerCodexAccount,
  removeCodexAccount,
  SettingsStore,
} from "@clankie/settings";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  ACCOUNTS_PATH,
  ACCOUNT_GOOGLE_START_PATH,
  ACCOUNT_GOOGLE_COMPLETE_PATH,
  ACCOUNT_GOOGLE_CHECK_PATH,
  AccountGoogleStartRequestSchema,
  AccountGoogleCompleteRequestSchema,
  AccountGoogleStartResultSchema,
  AccountGoogleCompleteResultSchema,
  ACCOUNT_DISCONNECT_PATH,
  ACCOUNT_GITHUB_POLL_PATH,
  ACCOUNT_GITHUB_START_PATH,
  ACCOUNT_LINEAR_COMPLETE_PATH,
  ACCOUNT_LINEAR_APP_PATH,
  AccountLinearAppRequestSchema,
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

/** Like model keys (ADR 0232): no request, token or provider-error logging, ever. */
export function createAccountRoutes(
  accounts: AccountsPort | undefined,
  authorize: (request: Request) => Promise<true | "authentication_required" | "forbidden">,
  settings: Pick<SettingsStore, "load"> & Partial<Pick<SettingsStore, "update">> = new SettingsStore(),
): Hono {
  const app = new Hono();
  const paths = [
    "/v1/accounts/codex",
    ACCOUNTS_PATH,
    ACCOUNT_GOOGLE_START_PATH,
    ACCOUNT_GOOGLE_COMPLETE_PATH,
    ACCOUNT_GOOGLE_CHECK_PATH,
    ACCOUNT_GITHUB_START_PATH,
    ACCOUNT_GITHUB_POLL_PATH,
    ACCOUNT_LINEAR_START_PATH,
    ACCOUNT_LINEAR_COMPLETE_PATH,
    ACCOUNT_LINEAR_APP_PATH,
    ACCOUNT_DISCONNECT_PATH,
  ];
  for (const path of paths) {
    app.use(path, async (context, next) => {
      context.header("cache-control", "no-store");
      try {
        const authority = await authorize(context.req.raw);
        if (authority !== true)
          return context.json({ ok: false, error: authority }, authority === "forbidden" ? 403 : 401);
        if (accounts === undefined && path !== "/v1/accounts/codex")
          return context.json({ ok: false, error: "unavailable" }, 503);
        await next();
      } catch {
        return context.json({ ok: false, error: "unavailable" }, 503);
      }
    });
    app.use(
      path,
      bodyLimit({
        // Picker can return 100 file IDs of 256 characters, plus the code/state.
        maxSize: path === ACCOUNT_GOOGLE_COMPLETE_PATH ? 32 * 1024 : 16 * 1024,
        onError: (context) => context.json({ ok: false, error: "malformed" }, 413),
      }),
    );
  }
  app.get("/v1/accounts/codex", async (context) =>
    context.json({
      ok: true,
      accounts: await Promise.all(codexAccounts(await settings.load()).map(readCodexAccountStatus)),
    }),
  );
  app.post("/v1/accounts/codex", async (context) => {
    if (!settings.update) return context.json({ ok: false, error: "unavailable" }, 503);
    const writable = { load: () => settings.load(), update: settings.update.bind(settings) };
    const parsed = z
      .discriminatedUnion("op", [
        z
          .object({
            op: z.literal("add"),
            home: z.string().min(1),
            label: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u),
          })
          .strict(),
        z.object({ op: z.literal("remove"), label: z.string().min(1) }).strict(),
      ])
      .safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) return context.json({ ok: false, error: "malformed" }, 400);
    try {
      if (parsed.data.op === "add") await registerCodexAccount(writable, parsed.data);
      else await removeCodexAccount(writable, parsed.data.label);
      return context.json({ ok: true });
    } catch {
      return context.json({ ok: false, error: "invalid_account" }, 400);
    }
  });
  app.get(ACCOUNTS_PATH, async (context) => {
    try {
      return context.json(AccountsResponseSchema.parse(await accounts!.list()));
    } catch {
      return context.json({ ok: false, error: "unavailable" }, 503);
    }
  });
  const post = (
    path: string,
    handle: (body: unknown, guard: () => Promise<void>) => Promise<{ ok: boolean }>,
  ) =>
    app.post(path, async (context) => {
      try {
        const guard = async () => {
          if ((await authorize(context.req.raw)) !== true) throw new Error("Account owner authority changed");
        };
        const safe = await handle(await context.req.json().catch(() => ({})), guard);
        await guard();
        return context.json(safe, safe.ok ? 200 : 400);
      } catch {
        // Broker and provider failures may carry a token. Never forward or log them.
        return context.json({ ok: false, error: "unavailable" }, 503);
      }
    });
  const malformed = { ok: false, error: "malformed" } as const;
  post(ACCOUNT_GOOGLE_START_PATH, async (body) => {
    const parsed = AccountGoogleStartRequestSchema.safeParse(body);
    return parsed.success
      ? AccountGoogleStartResultSchema.parse(await accounts!.startGoogle(parsed.data.provider))
      : malformed;
  });
  post(ACCOUNT_GOOGLE_COMPLETE_PATH, async (body, guard) => {
    const parsed = AccountGoogleCompleteRequestSchema.safeParse(body);
    return parsed.success
      ? AccountGoogleCompleteResultSchema.parse(
          await accounts!.completeGoogle(
            parsed.data.provider,
            parsed.data.state,
            parsed.data.code,
            guard,
            parsed.data.pickedFileIds,
          ),
        )
      : malformed;
  });
  post(ACCOUNT_GOOGLE_CHECK_PATH, async (body, guard) => {
    const parsed = AccountGoogleStartRequestSchema.safeParse(body);
    return parsed.success
      ? AccountGoogleCompleteResultSchema.parse(await accounts!.checkGoogle(parsed.data.provider, guard))
      : malformed;
  });
  post(ACCOUNT_GITHUB_START_PATH, async () =>
    AccountGithubStartResultSchema.parse(await accounts!.startGithub()),
  );
  post(ACCOUNT_GITHUB_POLL_PATH, async (body, guard) => {
    const parsed = AccountGithubPollRequestSchema.safeParse(body);
    return parsed.success
      ? AccountGithubPollResultSchema.parse(await accounts!.pollGithub(parsed.data.flowId, guard))
      : malformed;
  });
  post(ACCOUNT_LINEAR_START_PATH, async () =>
    AccountLinearStartResultSchema.parse(await accounts!.startLinear()),
  );
  post(ACCOUNT_LINEAR_COMPLETE_PATH, async (body, guard) => {
    const parsed = AccountLinearCompleteRequestSchema.safeParse(body);
    return parsed.success
      ? AccountLinearCompleteResultSchema.parse(
          await accounts!.completeLinear(parsed.data.state, parsed.data.code, guard),
        )
      : malformed;
  });
  post(ACCOUNT_LINEAR_APP_PATH, async (body, guard) => {
    const parsed = AccountLinearAppRequestSchema.safeParse(body);
    return parsed.success
      ? AccountLinearCompleteResultSchema.parse(await accounts!.connectLinearApp(parsed.data, guard))
      : malformed;
  });
  post(ACCOUNT_DISCONNECT_PATH, async (body, guard) => {
    const parsed = AccountDisconnectRequestSchema.safeParse(body);
    return parsed.success
      ? AccountDisconnectResultSchema.parse(await accounts!.disconnect(parsed.data.provider, guard))
      : malformed;
  });
  return app;
}
