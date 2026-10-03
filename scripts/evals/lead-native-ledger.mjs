/** Trusted native protocol accounting; filesystem transcripts are never quota authority. */
import { createHash } from "node:crypto";
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const integer = (n) => Number.isSafeInteger(n) && n >= 0;

function codexWindows(response, accountId, atMs) {
  const bucket = response?.rateLimitsByLimitId?.codex;
  if (!bucket || bucket.rateLimitReachedType != null || bucket.spendControlReached !== false)
    throw Error("Codex quota unknown/limited");
  const windows = [bucket.primary, bucket.secondary];
  const value = (minutes) => {
    const matches = windows.filter((w) => w?.windowDurationMins === minutes);
    if (
      matches.length !== 1 ||
      !Number.isFinite(matches[0].usedPercent) ||
      matches[0].usedPercent < 0 ||
      matches[0].usedPercent > 100 ||
      !Number.isFinite(matches[0].resetsAt) ||
      matches[0].resetsAt * 1000 <= atMs
    )
      throw Error(`Missing/invalid ${minutes}-minute native quota window`);
    return { used: matches[0].usedPercent / 100, resetsAtMs: matches[0].resetsAt * 1000 };
  };
  return { accountId, atMs, fiveHour: value(300), sevenDay: value(10080), source: "codex-account-rpc" };
}

/** RPC must be the controller's private connection to this exact native server. */
export class CodexAccountSource {
  constructor(rpc, { accountId, email }) {
    if (!accountId || !email) throw Error("Exact provider account and expected native email required");
    this.rpc = rpc;
    this.expected = { accountId, email };
  }
  async account() {
    const result = await this.rpc("account/read", { refreshToken: false });
    if (result?.account?.type !== "chatgpt" || result.account.email !== this.expected.email)
      throw Error("Native account identity unavailable or changed");
    return hash(result.account);
  }
  async snapshot(now = Date.now) {
    const before = await this.account();
    const response = await this.rpc("account/rateLimits/read", { excludeResetCreditDetails: true });
    // These fields are provider-backed in the pinned protocol. Older/unknown
    // servers are refused; orphan account/sessions/list types are NOT a callable RPC.
    if (response?.accountId !== this.expected.accountId || response.ordinaryUsageAllowed !== true)
      throw Error("Provider account attribution/ordinary usage permission unavailable");
    if ((await this.account()) !== before) throw Error("Account changed across quota observation");
    return {
      ...codexWindows(response, this.expected.accountId, now()),
      identitySha256: hash({ accountId: response.accountId, native: before }),
    };
  }
  /** Full pagination, archived and active. Any cursor loop or malformed page is failure. */
  async inventory() {
    const identity = (await this.snapshot()).identitySha256;
    const threads = new Map();
    for (const archived of [false, true]) {
      let cursor = null;
      const seen = new Set();
      do {
        const page = await this.rpc("thread/list", {
          cursor,
          archived,
          limit: 100,
          sourceKinds: [],
        });
        if (!Array.isArray(page?.data) || !(page.nextCursor === null || typeof page.nextCursor === "string"))
          throw Error("Incomplete native thread inventory");
        for (const thread of page.data) {
          if (typeof thread.id !== "string" || !thread.id || typeof thread.cwd !== "string")
            throw Error("Malformed native thread identity");
          const prior = threads.get(thread.id);
          if (prior && (prior.parentThreadId !== thread.parentThreadId || prior.cwd !== thread.cwd))
            throw Error("Conflicting native thread identity");
          threads.set(thread.id, thread);
        }
        cursor = page.nextCursor;
        if (cursor !== null && (seen.has(cursor) || !cursor)) throw Error("Native inventory cursor loop");
        seen.add(cursor);
      } while (cursor !== null);
    }
    if ((await this.snapshot()).identitySha256 !== identity) throw Error("Account changed across inventory");
    return { accountId: this.expected.accountId, identitySha256: identity, threads: [...threads.values()] };
  }
}

/** Cumulative thread counters avoid double-counting repeated updates or nested cache fields. */
export class NativeUsageLedger {
  #sessions = new Map();
  #roots = new Map();
  #issues = new Set();
  #events = [];
  #sequence = 0;
  #lastHash = "0".repeat(64);
  authorizeRoot({ sessionId, accountId, cwd, paneId }) {
    if (!sessionId || !accountId || !cwd || !paneId || this.#roots.has(sessionId))
      throw Error("Missing/duplicate exact native root binding");
    this.#roots.set(sessionId, { sessionId, accountId, cwd, paneId });
    this.record("root", { sessionId, accountId, cwd, paneId });
  }
  record(type, data) {
    const event = { sequence: ++this.#sequence, previous: this.#lastHash, type, data: structuredClone(data) };
    this.#lastHash = hash(event);
    this.#events.push({ ...event, sha256: this.#lastHash });
  }
  inventory({ accountId, threads }, atMs) {
    const candidates = new Map(threads.map((t) => [t.id, t]));
    for (const thread of threads) {
      let current = thread;
      const chain = new Set();
      while (!this.#roots.has(current.id)) {
        if (chain.has(current.id) || !current.parentThreadId || !candidates.has(current.parentThreadId)) {
          this.#issues.add(`unattributed native session ${thread.id}`);
          break;
        }
        chain.add(current.id);
        current = candidates.get(current.parentThreadId);
      }
      const root = this.#roots.get(current.id);
      if (!root || root.accountId !== accountId || root.cwd !== current.cwd) {
        this.#issues.add(`wrong account/root for ${thread.id}`);
        continue;
      }
      for (const existing of this.#sessions.values())
        if (existing.sessionId !== thread.id && existing.cwd === thread.cwd)
          this.#issues.add(`shared native workspace ${thread.cwd}`);
      const old = this.#sessions.get(thread.id);
      if (
        old &&
        (old.accountId !== accountId ||
          old.cwd !== thread.cwd ||
          old.parentSessionId !== (thread.parentThreadId ?? null))
      )
        this.#issues.add(`session binding changed ${thread.id}`);
      this.#sessions.set(thread.id, {
        ...old,
        sessionId: thread.id,
        accountId,
        parentSessionId: thread.parentThreadId ?? null,
        cwd: thread.cwd,
        inventoryAtMs: atMs,
      });
    }
    // A disappeared session is not silently dropped from the ledger.
    for (const session of this.#sessions.values())
      if (session.accountId === accountId && !candidates.has(session.sessionId))
        this.#issues.add(`native session disappeared ${session.sessionId}`);
    this.record("inventory", { accountId, atMs, sessionIds: [...candidates.keys()] });
  }
  dispatch(accountId, sessionId, { method = "turn/start", turnId } = {}) {
    const session = this.#sessions.get(sessionId);
    if (!session || session.accountId !== accountId) {
      this.#issues.add(`unknown native dispatch ${sessionId}`);
      return;
    }
    if (Object.values(session.turns ?? {}).some((turn) => turn.completed && !turn.usage))
      this.#issues.add(`prior native turn lacks settled usage ${sessionId}`);
    if (method === "turn/start") session.pendingDispatch = true;
    else if (method !== "turn/steer" || !turnId || session.activeTurn !== turnId)
      this.#issues.add(`unmatched native steer ${sessionId}`);
    this.record("dispatch-admission", { accountId, sessionId });
  }
  lifecycle(accountId, event) {
    const { threadId, turn } = event.params ?? {};
    const session = this.#sessions.get(threadId);
    if (!session || session.accountId !== accountId || !turn?.id || typeof turn.id !== "string") {
      this.#issues.add(`unknown native turn ${threadId}`);
      return;
    }
    session.turns ??= Object.create(null);
    if (event.method === "turn/started") {
      if ((session.activeTurn && session.activeTurn !== turn.id) || session.turns[turn.id]?.completed)
        this.#issues.add(`overlapping/reused native turn ${threadId}`);
      session.turns[turn.id] ??= { usage: false, completed: false };
      session.activeTurn = turn.id;
      session.pendingDispatch = false;
    } else if (event.method === "turn/completed") {
      const known = session.turns[turn.id];
      if (!known || (!known.completed && session.activeTurn !== turn.id))
        this.#issues.add(`native completion without matching start ${threadId}`);
      else if (known.completed) {
        if (known.status !== turn.status || turn.error != null)
          this.#issues.add(`conflicting native completion ${threadId}/${turn.id}`);
      } else {
        known.completed = true;
        known.status = turn.status;
        if (turn.status !== "completed" || turn.error != null)
          this.#issues.add(`native turn outcome uncertain ${threadId}/${turn.id}`);
        session.activeTurn = undefined;
      }
    } else {
      this.#issues.add("unknown native lifecycle event");
      return;
    }
    this.record("turn-lifecycle", { accountId, event });
  }
  usage(accountId, event) {
    if (event.method !== "thread/tokenUsage/updated") return;
    const { threadId, turnId, tokenUsage } = event.params;
    const session = this.#sessions.get(threadId);
    const usage = tokenUsage?.total;
    const keys = ["totalTokens", "inputTokens", "cachedInputTokens", "outputTokens", "reasoningOutputTokens"];
    if (
      !session ||
      session.accountId !== accountId ||
      !session.turns?.[turnId] ||
      typeof turnId !== "string" ||
      !turnId ||
      turnId.length > 256 ||
      !usage ||
      !keys.every((key) => integer(usage[key])) ||
      usage.cachedInputTokens > usage.inputTokens ||
      usage.reasoningOutputTokens > usage.outputTokens
    ) {
      this.#issues.add(`unknown native usage ${threadId}`);
      return;
    }
    if (session.usage && keys.some((key) => usage[key] < session.usage[key]))
      this.#issues.add(`native cumulative usage regressed ${threadId}`);
    session.usage = { ...usage };
    session.turns[turnId].usage = true;
    this.record("usage", { accountId, threadId, turnId, usage });
  }
  result() {
    const sessions = structuredClone([...this.#sessions.values()]);
    const issues = [...this.#issues];
    for (const root of this.#roots.keys()) if (!this.#sessions.has(root)) issues.push(`missing root ${root}`);
    for (const session of sessions) {
      if (!session.usage) issues.push(`missing usage ${session.sessionId}`);
      if (session.pendingDispatch) issues.push(`native dispatch outcome missing ${session.sessionId}`);
      if (session.activeTurn)
        issues.push(`native turn still active ${session.sessionId}/${session.activeTurn}`);
      for (const [id, turn] of Object.entries(session.turns ?? {}))
        if (!turn.completed || !turn.usage)
          issues.push(`native turn coverage incomplete ${session.sessionId}/${id}`);
    }
    const complete = this.#roots.size > 0 && issues.length === 0;
    const perAccount = {};
    if (complete)
      for (const session of sessions)
        perAccount[session.accountId] = (perAccount[session.accountId] ?? 0) + session.usage.totalTokens;
    return {
      complete,
      valid: this.#issues.size === 0,
      issues,
      sessions,
      perAccount: complete ? perAccount : null,
      totalTokens: complete ? Object.values(perAccount).reduce((a, b) => a + b, 0) : null,
      events: structuredClone(this.#events),
      lastHash: this.#lastHash,
      limitation:
        "Trusted protocol observations; completeness additionally requires enforced launch/credential containment",
    };
  }
}

/** Terminal stop latch: missing telemetry, quota reset, or timeout never auto-resumes. */
export class NativeBudgetGuard {
  #stopped;
  #snapshots = new Map();
  #identities = new Map();
  constructor({
    accounts,
    stop,
    now = Date.now,
    maxAgeMs = 15_000,
    thresholds = { fiveHour: 0.8, sevenDay: 0.5 },
  }) {
    if (
      !accounts.length ||
      new Set(accounts).size !== accounts.length ||
      !Number.isFinite(maxAgeMs) ||
      maxAgeMs <= 0 ||
      !["fiveHour", "sevenDay"].every((key) => thresholds[key] > 0 && thresholds[key] <= 1)
    )
      throw Error("Invalid guard policy");
    Object.assign(this, { accounts: [...accounts], stop, now, maxAgeMs, thresholds });
  }
  observe(snapshot) {
    if (this.#stopped) throw Error("Stop latched");
    if (!Number.isFinite(snapshot.atMs)) throw Error("Unknown observation time");
    if (!this.accounts.includes(snapshot.accountId)) throw Error("Unregistered account");
    const old = this.#snapshots.get(snapshot.accountId);
    if (old && ["fiveHour", "sevenDay"].some((key) => snapshot[key]?.resetsAtMs !== old[key].resetsAtMs))
      throw Error("Quota window changed; a separate run decision is required");
    const identity = this.#identities.get(snapshot.accountId);
    if (!snapshot.identitySha256 || (identity && identity !== snapshot.identitySha256))
      throw Error("Account provenance changed");
    this.#identities.set(snapshot.accountId, snapshot.identitySha256);
    this.#snapshots.set(snapshot.accountId, snapshot);
  }
  async fail(reason) {
    if (!this.#stopped) this.#stopped = Promise.resolve().then(() => this.stop(reason));
    await this.#stopped;
    throw Error(`Native run stopped: ${reason}`);
  }
  assertCurrent() {
    if (this.#stopped) throw Error("stop latched");
    const now = this.now();
    for (const account of this.accounts) {
      const snapshot = this.#snapshots.get(account);
      if (!snapshot || now < snapshot.atMs || now - snapshot.atMs > this.maxAgeMs)
        throw Error(`missing/stale account telemetry ${account}`);
      for (const key of ["fiveHour", "sevenDay"]) {
        const window = snapshot[key];
        if (
          !window ||
          !Number.isFinite(window.used) ||
          window.used < 0 ||
          window.used >= this.thresholds[key] ||
          !Number.isFinite(window.resetsAtMs) ||
          window.resetsAtMs <= now
        )
          throw Error(`unknown/exhausted ${key} ${account}`);
      }
    }
    return { admitted: true };
  }
  async admit() {
    try {
      return this.assertCurrent();
    } catch (error) {
      return this.fail(error.message);
    }
  }
  /** Monitor is installed only by an authorized runtime; no import-time/background timer. */
  async monitor(sources, signal, intervalMs = 1000) {
    if (!(intervalMs > 0 && intervalMs < this.maxAgeMs)) throw Error("Invalid monitor interval");
    let rejectWatchdog;
    const stopped = new Promise((_, reject) => {
      rejectWatchdog = reject;
    });
    // This watchdog runs independently of a stalled provider RPC.
    const watchdog = setInterval(
      () => {
        void this.admit().catch(rejectWatchdog);
      },
      Math.min(intervalMs, 250),
    );
    const aborted = new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    try {
      while (!signal.aborted) {
        const refresh = Promise.all(sources.map((source) => source.snapshot(this.now)));
        const snapshots = await Promise.race([refresh, stopped, aborted]);
        if (signal.aborted) break;
        for (const snapshot of snapshots) this.observe(snapshot);
        await this.admit();
        await Promise.race([new Promise((resolve) => setTimeout(resolve, intervalMs)), stopped, aborted]);
      }
    } catch (error) {
      return this.fail(error.message);
    } finally {
      clearInterval(watchdog);
    }
  }
}
