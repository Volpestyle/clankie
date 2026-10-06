import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { FileCredentialStore, LINEAR_API_PROVIDER_ID } from "@clankie/credential-broker";
import type { LinearRequestBudgetAccount } from "@clankie/protocol/linear-request-budget";
import { createLinearApiTracker } from "../src/linear-api-tracker.ts";
import { LinearRequestBudget } from "../src/linear-request-budget.ts";
import { API_ACCESS, API_REFRESH, USER_ID, createLinearApiProvider } from "./fixtures/linear-api-provider.ts";

// Explicit manual lane: a real 60-second lifecycle timer, never enabled by ordinary CI.
it.skipIf(process.env.LINEAR_WARNING_TIMER_TEST !== "1")(
  "retries native warning admission autonomously after 60 real seconds without another provider request",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-budget-autonomous-"));
    const attempts: { at: number; account: LinearRequestBudgetAccount }[] = [];
    let secondAttempt!: () => void;
    const retried = new Promise<void>((resolve) => {
      secondAttempt = resolve;
    });
    const budget = new LinearRequestBudget({
      onAlert: (account) => {
        attempts.push({ at: Date.now(), account });
        if (attempts.length === 1) return false;
        secondAttempt();
        return true;
      },
    });
    const provider = await createLinearApiProvider({
      requestBudget: {
        clock: Date.now,
        limit: 5_000,
        previousRequests: Array.from({ length: 2_499 }, () => Date.now()),
      },
    });
    try {
      const credentials = new FileCredentialStore(join(directory, "credentials.json"));
      await credentials.set(LINEAR_API_PROVIDER_ID, {
        type: "oauth",
        access: API_ACCESS,
        refresh: API_REFRESH,
        expires: 0,
        linearAuth: "api",
        account: {
          provider: "linear",
          connectionId: randomUUID(),
          workspaceId: "personal-workspace",
          userId: USER_ID,
          actor: "app",
          name: "Clankie",
          workspaceName: "Personal",
          verifiedAt: new Date().toISOString(),
        },
      });
      const tracker = createLinearApiTracker({
        credentials,
        fetch: provider.fetch,
        requestBudget: budget,
      });
      await tracker.call("list_teams", {});
      expect(attempts).toHaveLength(1);
      expect(attempts[0]!.account).toMatchObject({ used: 2_500, status: "warning" });
      expect(provider.seen).toHaveLength(1);

      // No report(), provider traffic, injected clock, or timer manipulation during this wait.
      await retried;
      expect(attempts).toHaveLength(2);
      expect(attempts[1]!.at - attempts[0]!.at).toBeGreaterThanOrEqual(60_000);
      expect(attempts[1]!.account).toMatchObject({
        accountId: attempts[0]!.account.accountId,
        used: 2_500,
        status: "warning",
      });
      expect(provider.seen).toHaveLength(1);
      expect(provider.validationErrors).toEqual([]);
      expect(provider.rateLimited()).toBe(0);
    } finally {
      budget.close();
      await provider.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  90_000,
);
