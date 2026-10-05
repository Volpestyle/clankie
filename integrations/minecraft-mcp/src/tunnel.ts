import {
  MinecraftTunnelErrorSchema,
  type MinecraftTunnelClaimStatus,
  type MinecraftTunnelError,
} from "@clankie/protocol";
import { createHash, randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { z } from "zod";

export const PLAYIT_PIN = {
  version: "0.17.1",
  commit: "3adf0fd4fb72c866511890eabb766732734f3cda",
  sourceSha256: "d9aa41cc572cd64e1d81651f640d35318797122a3d5229a105242b289a33cfa5",
} as const;
const API_BASE = "https://api.playit.gg";
const MAX_RESPONSE_BYTES = 1_048_576;
const TUNNEL_NAME = "Clankie Minecraft";
const ALLOCATION_PENDING = "allocation-pending";
const AllocationIntent = z.object({
  agent_id: z.uuid(),
  outcome: z.enum(["uncertain", "rejected"]),
});
const RunData = z.object({
  agent_id: z.uuid(),
  tunnels: z
    .array(
      z.object({
        id: z.uuid(),
        name: z.string(),
        display_address: z.string().max(253),
        port_type: z.string(),
        port_count: z.number().int(),
        tunnel_type: z.string().nullable(),
        disabled_reason: z.string().nullable(),
        agent_config: z.object({ fields: z.array(z.object({ name: z.string(), value: z.string() })) }),
      }),
    )
    .max(256),
  pending: z.array(z.object({ id: z.uuid(), name: z.string() })).max(256),
  permissions: z.object({
    is_self_managed: z.boolean(),
    has_premium: z.boolean(),
    account_status: z.enum(["guest", "email-not-verified", "verified"]),
  }),
});
type AgentTunnel = z.infer<typeof RunData>["tunnels"][number];
type TunnelStatus = {
  phase: "stopped" | "blocked-on-claim" | "starting" | "running" | "backoff" | "failed";
  publicAddress?: string;
  tunnelId?: string;
  retryAt?: string;
  error?: MinecraftTunnelError;
};
type TunnelOptions = {
  dataDir: string;
  originPort: number;
  credentials: { get(): Promise<string | null>; set(secret: string): Promise<void> };
  authReady(): boolean | Promise<boolean>;
  api?: (path: string, request: unknown, secret?: string) => Promise<unknown>;
  apiBase?: string;
  install?: (dataDir: string) => Promise<string>;
  launch?: (binary: string, args: string[], cwd: string) => ChildProcess;
  now?: () => number;
  onClaimed?: () => Promise<void>;
};

class PlayitApiError extends Error {
  constructor(code: MinecraftTunnelError) {
    super(code);
  }
}
/** Never include remote response bodies, credentials or child output in errors. */
async function api(path: string, request: unknown, secret?: string, base = API_BASE): Promise<unknown> {
  try {
    const response = await fetch(`${base}${path}`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
      headers: {
        "content-type": "application/json",
        ...(secret ? { authorization: `Agent-Key ${secret}` } : {}),
      },
      body: JSON.stringify(request),
    });
    if (!response.body) throw new Error();
    const reader = response.body.getReader();
    let length = 0;
    const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > MAX_RESPONSE_BYTES) throw new Error();
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    let result: { status: "success" | "fail" | "error"; data: unknown };
    try {
      result = z
        .object({ status: z.enum(["success", "fail", "error"]), data: z.unknown() })
        .parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    } catch {
      throw new PlayitApiError("playit-api-invalid-response");
    }
    if (result.status === "fail") {
      if (result.data === "CodeExpired" && (path === "/claim/setup" || path === "/claim/exchange")) {
        throw new Error("playit-claim-expired");
      }
      throw new PlayitApiError(
        result.data === "RequiresVerifiedAccount"
          ? "playit-email-verification-required"
          : "playit-api-rejected",
      );
    }
    if (result.status === "error") {
      const remote = z.object({ type: z.string(), message: z.unknown() }).safeParse(result.data);
      if (!remote.success) throw new PlayitApiError("playit-api-invalid-response");
      throw new PlayitApiError(
        remote.data.type === "auth" && remote.data.message === "EmailMustBeVerified"
          ? "playit-email-verification-required"
          : remote.data.type === "internal"
            ? "playit-api-unavailable"
            : "playit-api-rejected",
      );
    }
    if (!response.ok) throw new PlayitApiError("playit-api-unavailable");
    return result.data;
  } catch (error) {
    if (error instanceof PlayitApiError) throw error;
    if (error instanceof Error && error.message === "playit-claim-expired") throw error;
    throw new PlayitApiError("playit-api-unavailable");
  }
}
function launch(binary: string, args: string[], cwd: string): ChildProcess {
  return spawn(binary, args, {
    cwd,
    stdio: "ignore",
    env: { PATH: process.env.PATH, HOME: cwd, API_BASE, PLAYIT_LOG: "off" },
  });
}
async function command(binary: string, args: string[], cwd: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(binary, args, { cwd, stdio: "ignore" });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("playit-install-timeout"));
    }, 10 * 60_000);
    child.once("error", () => {
      clearTimeout(timer);
      reject(new Error("playit-install-failed"));
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error("playit-install-failed"));
    });
  });
}
export async function installedPlayit(dataDir: string): Promise<string> {
  if (process.platform !== "darwin") throw new Error("playit-platform-not-supported");
  const root = join(dataDir, `playit-${PLAYIT_PIN.commit}`);
  const binary = join(root, `playit-agent-${PLAYIT_PIN.commit}`, "target/release/playit-cli");
  try {
    const recorded = (await readFile(join(root, "binary.sha256"), "utf8")).trim();
    const actual = createHash("sha256")
      .update(await readFile(binary))
      .digest("hex");
    if (recorded === actual && /^[a-f0-9]{64}$/.test(recorded)) return binary;
  } catch {
    /* explicit setup must provision the pinned executable */
  }
  throw new Error("playit-install-required");
}
/** Mac has no official binary asset: compile the checked official source and locked dependencies. */
async function installPlayit(dataDir: string): Promise<string> {
  if (process.platform !== "darwin") throw new Error("playit-platform-not-supported");
  const root = join(dataDir, `playit-${PLAYIT_PIN.commit}`);
  const source = join(root, `playit-agent-${PLAYIT_PIN.commit}`);
  const binary = join(source, "target/release/playit-cli");
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  try {
    return await installedPlayit(dataDir);
  } catch {
    /* explicit claim setup provisions from pinned source */
  }
  const response = await fetch(
    `https://github.com/playit-cloud/playit-agent/archive/${PLAYIT_PIN.commit}.tar.gz`,
    {
      signal: AbortSignal.timeout(60_000),
    },
  );
  if (!response.ok) throw new Error("playit-download-failed");
  const archive = Buffer.from(await response.arrayBuffer());
  if (
    archive.length > 10_000_000 ||
    createHash("sha256").update(archive).digest("hex") !== PLAYIT_PIN.sourceSha256
  ) {
    throw new Error("playit-source-checksum-mismatch");
  }
  await writeFile(join(root, "source.tar.gz"), archive, { mode: 0o600 });
  await command("tar", ["-xzf", join(root, "source.tar.gz"), "-C", root], root);
  await command("cargo", ["build", "--release", "--locked", "-p", "playit-cli"], source);
  const digest = createHash("sha256")
    .update(await readFile(binary))
    .digest("hex");
  await writeFile(join(root, "binary.sha256"), `${digest}\n`, { mode: 0o600 });
  // LICENSE.txt remains alongside the source/binary; never redistribute without it.
  return binary;
}

export class MinecraftTunnel {
  private readonly options: TunnelOptions;
  private readonly request: NonNullable<TunnelOptions["api"]>;
  private state: TunnelStatus = { phase: "stopped" };
  private child: ChildProcess | undefined;
  private claim: { code: string; expiresAt: number; secret?: string } | undefined;
  private claimTimer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private claimPreparation: Promise<void> | undefined;
  private claimError: MinecraftTunnelClaimStatus["error"];
  private claimPhase: MinecraftTunnelClaimStatus["phase"] = "idle";
  private retry: ReturnType<typeof setTimeout> | undefined;
  private desired = false;
  private monitor: ReturnType<typeof setInterval> | undefined;
  private monitoring = false;
  private cleanup: Promise<void> = Promise.resolve();
  private stopping: Promise<TunnelStatus> | undefined;
  private attempts = 0;
  private operation: Promise<TunnelStatus> | undefined;
  private readonly secretPath: string;

  constructor(options: TunnelOptions) {
    if (!Number.isInteger(options.originPort) || options.originPort < 1 || options.originPort > 65535) {
      throw new Error("playit-origin-port-invalid");
    }
    this.options = options;
    this.request = options.api ?? ((path, request, secret) => api(path, request, secret, options.apiBase));
    this.secretPath = join(options.dataDir, "playit-runtime", "agent.secret");
  }
  status(): TunnelStatus {
    return { ...this.state };
  }
  claimStatus(): MinecraftTunnelClaimStatus {
    if (this.claim && this.now() >= this.claim.expiresAt) {
      this.clearClaimTimer();
      this.claim = undefined;
      this.claimPhase = "expired";
    }
    return {
      phase: this.claimPhase,
      claimed: this.claimPhase === "claimed",
      ...(this.claimError ? { error: this.claimError } : {}),
      ...(this.claim
        ? {
            claimUrl: `https://playit.gg/claim/${this.claim.code}`,
            expiresAt: new Date(this.claim.expiresAt).toISOString(),
          }
        : {}),
    };
  }
  async prepareClaim(): Promise<MinecraftTunnelClaimStatus> {
    const current = this.claimStatus();
    if (this.closed) return current;
    if (this.claimPreparation || current.phase === "pending" || current.phase === "claimed") return current;
    this.claimPhase = "preparing";
    this.claimError = undefined;
    // Keep compilation outside the request lifetime: MCP/API callers can return
    // immediately and observe this same job after their request has completed.
    this.claimPreparation = this.prepareClaimOnce().finally(() => {
      this.claimPreparation = undefined;
    });
    return this.claimStatus();
  }
  private async prepareClaimOnce(): Promise<void> {
    // Source compilation belongs to explicit setup, never service or game startup.
    try {
      await (this.options.install ?? installPlayit)(this.options.dataDir);
    } catch {
      if (this.closed) return;
      this.claimPhase = "failed";
      this.claimError = "playit-install-failed";
      return;
    }
    if (this.closed) return;
    this.claim = { code: randomBytes(5).toString("hex"), expiresAt: this.now() + 10 * 60_000 };
    this.claimPhase = "pending";
    await this.pollClaim();
  }
  /** Compatibility endpoint: clients observe the integration-owned claim job. */
  async completeClaim(): Promise<MinecraftTunnelClaimStatus> {
    return this.claimStatus();
  }
  private clearClaimTimer(): void {
    if (this.claimTimer) clearTimeout(this.claimTimer);
    this.claimTimer = undefined;
  }
  /** Retire an obsolete controller without leaving its account claim alive. */
  async close(): Promise<TunnelStatus> {
    this.closed = true;
    this.clearClaimTimer();
    this.claim = undefined;
    this.claimPhase = "idle";
    this.claimError = undefined;
    return this.stop();
  }
  private async pollClaim(): Promise<void> {
    this.claimStatus();
    const claim = this.claim;
    if (!claim || this.closed) return;
    try {
      const status = claim.secret
        ? "UserAccepted"
        : z.enum(["WaitingForUserVisit", "WaitingForUser", "UserAccepted", "UserRejected"]).parse(
            await this.request("/claim/setup", {
              code: claim.code,
              agent_type: "self-managed",
              version: `playit-cli ${PLAYIT_PIN.version}`,
            }),
          );
      this.claimStatus();
      if (this.claim !== claim || this.closed) return;
      this.claimError = undefined;
      if (status === "UserRejected") {
        this.claim = undefined;
        this.claimPhase = "rejected";
        return;
      }
      if (status === "UserAccepted") {
        if (!claim.secret) {
          const result = z
            .object({ secret_key: z.string().regex(/^[a-fA-F0-9]{32,512}$/) })
            .parse(await this.request("/claim/exchange", { code: claim.code }));
          this.claimStatus();
          if (this.claim !== claim || this.closed) return;
          // Retain only in memory until broker persistence succeeds; never exchange twice.
          claim.secret = result.secret_key;
        }
        await this.options.credentials.set(claim.secret);
        if (this.claim !== claim || this.closed) return;
        this.claim = undefined;
        this.claimPhase = "claimed";
        if (this.state.phase === "blocked-on-claim") this.state = { phase: "stopped" };
        // Credential completion is independent of a waiting CLI or MCP caller.
        await this.options.onClaimed?.();
        return;
      }
    } catch (error) {
      if (this.claim !== claim || this.closed) return;
      if (error instanceof Error && error.message === "playit-claim-expired") {
        this.claim = undefined;
        this.claimPhase = "expired";
        return;
      }
      // A temporary API outage must not require the owner to keep a client open.
      this.claimError = "playit-claim-unavailable";
    }
    this.claimStatus();
    if (this.claim !== claim || this.closed) return;
    this.claimTimer = setTimeout(
      () => {
        this.claimTimer = undefined;
        void this.pollClaim();
      },
      Math.min(3000, Math.max(0, claim.expiresAt - this.now())),
    );
    this.claimTimer.unref();
  }
  start(): Promise<TunnelStatus> {
    if (this.stopping) return this.stopping.then(() => this.start());
    if (this.operation) return this.operation;
    if (this.child) return Promise.resolve(this.status());
    if (this.retry) {
      clearTimeout(this.retry);
      this.retry = undefined;
    }
    this.desired = true;
    this.operation = this.startOnce().finally(() => {
      this.operation = undefined;
    });
    return this.operation;
  }
  private async startOnce(): Promise<TunnelStatus> {
    this.state = { phase: "starting" };
    try {
      if (!(await this.options.authReady())) throw new Error("playit-auth-not-ready");
      const secret = await this.options.credentials.get();
      if (!secret) {
        this.state = { phase: "blocked-on-claim" };
        return this.status();
      }
      if (!/^[a-fA-F0-9]{32,512}$/.test(secret)) throw new Error("playit-credential-invalid");
      const binary = await (this.options.install ?? installedPlayit)(this.options.dataDir);
      if (!this.desired || !(await this.options.authReady())) throw new Error("playit-auth-not-ready");
      const address = await this.ensureTunnel(secret);
      if (!this.desired || !(await this.options.authReady())) throw new Error("playit-auth-not-ready");
      const runtime = join(this.options.dataDir, "playit-runtime");
      await mkdir(runtime, { recursive: true, mode: 0o700 });
      await chmod(runtime, 0o700);
      await rm(this.secretPath, { force: true });
      await writeFile(this.secretPath, secret, { mode: 0o600, flag: "wx" });
      const child = (this.options.launch ?? launch)(
        binary,
        ["--secret_path", this.secretPath, "--stdout", "start"],
        runtime,
      );
      this.child = child;
      const onExit = () => {
        void this.exited(child);
      };
      child.once("exit", onExit);
      child.once("error", () => {
        // Spawn failures have no process; a failed signal is not proof of termination.
        if (!child.pid) onExit();
        else this.state = { phase: "failed", error: "playit-process-error" };
      });
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", () => reject(new Error("playit-start-failed")));
      });
      this.state = { phase: "running", ...address };
      this.monitor = setInterval(() => {
        void this.checkHealth(child, secret);
      }, 15_000);
      this.monitor.unref();
      return this.status();
    } catch (error) {
      if (!this.child) await rm(this.secretPath, { force: true });
      const safe = MinecraftTunnelErrorSchema.safeParse(error instanceof Error ? error.message : undefined);
      this.state = { phase: "failed", error: safe.success ? safe.data : "playit-start-failed" };
      return this.status();
    }
  }
  private async ensureTunnel(
    secret: string,
    allowCreate = true,
  ): Promise<{ tunnelId: string; publicAddress: string }> {
    const ownedPath = join(this.options.dataDir, "playit-tunnel-id");
    await mkdir(this.options.dataDir, { recursive: true, mode: 0o700 });
    let compromised = false;
    let release: () => Promise<void>;
    try {
      release = await lockfile.lock(ownedPath, {
        realpath: false,
        stale: 60_000,
        update: 10_000,
        retries: 0,
        onCompromised: () => {
          compromised = true;
        },
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ELOCKED") {
        throw new Error("playit-tunnel-allocation-pending");
      }
      throw error;
    }
    const assertHeld = () => {
      if (compromised) throw new Error("playit-tunnel-allocation-pending");
    };
    try {
      const address = await this.ensureTunnelLocked(secret, allowCreate, assertHeld);
      assertHeld();
      return address;
    } finally {
      await release();
    }
  }
  private async ensureTunnelLocked(
    secret: string,
    allowCreate: boolean,
    assertHeld: () => void,
  ): Promise<{ tunnelId: string; publicAddress: string }> {
    const ownedPath = join(this.options.dataDir, "playit-tunnel-id");
    const intentPath = `${ownedPath}.intent`;
    let ownedId: string | undefined;
    let allocationPending = false;
    try {
      const saved = (await readFile(ownedPath, "utf8")).trim();
      if (saved === ALLOCATION_PENDING) allocationPending = true;
      else ownedId = z.uuid().parse(saved);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("playit-tunnel-unsafe");
    }
    let intent: z.infer<typeof AllocationIntent> | undefined;
    try {
      intent = AllocationIntent.parse(JSON.parse(await readFile(intentPath, "utf8")));
      if (!ownedId) allocationPending = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("playit-tunnel-unsafe");
    }
    const readData = async () => {
      const parsed = RunData.safeParse(await this.request("/v1/agents/rundata", {}, secret));
      if (!parsed.success) throw new PlayitApiError("playit-api-invalid-response");
      return parsed.data;
    };
    let data = await readData();
    const agentId = data.agent_id;
    if (intent && intent.agent_id !== agentId) throw new Error("playit-tunnel-unsafe");
    const refresh = async () => {
      const next = await readData();
      if (next.agent_id !== agentId) throw new Error("playit-tunnel-unsafe");
      return next;
    };
    const save = async (path: string, value: string) => {
      assertHeld();
      const next = `${path}.${randomBytes(8).toString("hex")}.new`;
      try {
        await writeFile(next, `${value}\n`, { mode: 0o600, flag: "wx" });
        assertHeld();
        await rename(next, path);
      } finally {
        await rm(next, { force: true });
      }
    };
    if (allocationPending) {
      // Rundata is scoped to this authenticated agent. A pending entry has no
      // origin config, so wait for it to become inspectable rather than allocate again.
      let emptyReads = 0;
      for (let attempt = 0; ; attempt++) {
        const named = data.tunnels.filter((tunnel) => tunnel.name === TUNNEL_NAME);
        if (named.length > 1 || named.some((tunnel) => !this.matchesOrigin(tunnel))) {
          throw new Error("playit-tunnel-unsafe");
        }
        if (data.pending.length > 0) {
          if (named.length > 0 || data.pending.length !== 1 || data.pending[0]?.name !== TUNNEL_NAME) {
            throw new Error("playit-tunnel-unsafe");
          }
          if (!allowCreate || attempt >= 10) throw new Error("playit-tunnel-allocation-pending");
          await this.waitForAllocation();
          data = await refresh();
          continue;
        }
        if (named[0]) {
          ownedId = named[0].id;
          await save(ownedPath, ownedId);
          assertHeld();
          await rm(intentPath, { force: true });
        } else {
          if (data.tunnels.some((tunnel) => tunnel.disabled_reason === null)) {
            throw new Error("playit-tunnel-unsafe");
          }
          if (!allowCreate) throw new Error("playit-tunnel-unsafe");
          // A lost response is not proof of rejection, even when the allocation
          // has not appeared in rundata. Only a definite rejection permits retry.
          if (intent?.outcome === "uncertain") throw new Error("playit-tunnel-allocation-pending");
          // Old versions wrote only the sentinel. Reconcile it repeatedly before
          // recovering their failed create, while the filesystem lease excludes overlap.
          if (!intent && ++emptyReads < 3) {
            await this.waitForAllocation();
            data = await refresh();
            continue;
          }
          assertHeld();
          await rm(ownedPath, { force: true });
          await rm(intentPath, { force: true });
        }
        break;
      }
    }
    if (
      data.tunnels.some((tunnel) => tunnel.id !== ownedId && tunnel.disabled_reason === null) ||
      data.pending.some((tunnel) => tunnel.id !== ownedId)
    ) {
      throw new Error("playit-tunnel-unsafe");
    }
    if (!ownedId) {
      if (!allowCreate) throw new Error("playit-tunnel-unsafe");
      if (data.permissions.account_status !== "verified") {
        throw new PlayitApiError("playit-email-verification-required");
      }
      // Persist uncertainty before external creation: an interrupted request must never allocate twice.
      assertHeld();
      intent = { agent_id: agentId, outcome: "uncertain" };
      await writeFile(intentPath, `${JSON.stringify(intent)}\n`, { mode: 0o600, flag: "wx" });
      await writeFile(ownedPath, `${ALLOCATION_PENDING}\n`, { mode: 0o600, flag: "wx" });
      let response: unknown;
      try {
        assertHeld();
        response = await this.request(
          "/v1/tunnels/create",
          {
            ports: { type: "tunnel-type", details: "minecraft-java" },
            origin: {
              type: "agent",
              data: {
                agent_id: agentId,
                config: {
                  fields: [
                    { name: "local_ip", value: "127.0.0.1" },
                    { name: "local_port", value: String(this.options.originPort) },
                    { name: "proxy_protocol", value: "proxy-protocol-v2" },
                  ],
                },
              },
            },
            enabled: true,
            alloc: null,
            name: TUNNEL_NAME,
            firewall_id: null,
          },
          secret,
        );
      } catch (error) {
        if (
          error instanceof Error &&
          (error.message === "playit-api-rejected" || error.message === "playit-email-verification-required")
        ) {
          await save(intentPath, JSON.stringify({ agent_id: agentId, outcome: "rejected" }));
        }
        throw error;
      }
      const created = z.object({ id: z.uuid() }).safeParse(response);
      if (!created.success) throw new PlayitApiError("playit-api-invalid-response");
      ownedId = created.data.id;
      await save(ownedPath, ownedId);
      assertHeld();
      await rm(intentPath, { force: true });
      data = await refresh();
    }
    // Allocation can be temporarily pending; retry the owned ID, never allocate twice.
    for (
      let attempt = 0;
      allowCreate && !data.tunnels.some((entry) => entry.id === ownedId) && attempt < 10;
      attempt++
    ) {
      await this.waitForAllocation();
      data = await refresh();
    }
    if (
      data.tunnels.some((entry) => entry.id !== ownedId && entry.disabled_reason === null) ||
      data.pending.some((entry) => entry.id !== ownedId)
    ) {
      throw new Error("playit-tunnel-unsafe");
    }
    const tunnel = data.tunnels.find((entry) => entry.id === ownedId);
    if (!tunnel && data.pending.some((entry) => entry.id === ownedId)) {
      throw new Error("playit-tunnel-allocation-pending");
    }
    if (!tunnel || tunnel.disabled_reason !== null || !this.matchesOrigin(tunnel)) {
      throw new Error("playit-tunnel-unsafe");
    }
    if (!/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[0-9]{1,5})?$/i.test(tunnel.display_address))
      throw new Error("playit-tunnel-unsafe");
    return { tunnelId: tunnel.id, publicAddress: tunnel.display_address };
  }
  private matchesOrigin(tunnel: AgentTunnel): boolean {
    if (tunnel.port_type !== "tcp" || tunnel.port_count !== 1 || tunnel.tunnel_type !== "minecraft-java")
      return false;
    return [
      ["local_ip", "127.0.0.1"],
      ["local_port", String(this.options.originPort)],
      ["proxy_protocol", "proxy-protocol-v2"],
    ].every(([name, expected]) => {
      const fields = tunnel.agent_config.fields.filter((field) => field.name === name);
      return fields.length === 1 && fields[0]?.value === expected;
    });
  }
  private async waitForAllocation(): Promise<void> {
    if (!this.desired || !(await this.options.authReady())) throw new Error("playit-auth-not-ready");
    await new Promise<void>((resolve) => setTimeout(resolve, 1000));
  }
  private async exited(child: ChildProcess): Promise<void> {
    if (this.child !== child) return;
    if (this.monitor) {
      clearInterval(this.monitor);
      this.monitor = undefined;
    }
    this.cleanup = rm(this.secretPath, { force: true });
    await this.cleanup;
    this.child = undefined;
    if (!this.desired) {
      this.state = { phase: "stopped" };
      return;
    }
    const delay = Math.min(60_000, 1000 * 2 ** Math.min(this.attempts++, 6));
    this.state = {
      phase: "backoff",
      retryAt: new Date(this.now() + delay).toISOString(),
      error: "playit-agent-exited",
    };
    this.retry = setTimeout(() => {
      this.retry = undefined;
      if (this.desired) void this.start();
    }, delay);
    this.retry.unref();
  }
  private async checkHealth(child: ChildProcess, secret: string): Promise<void> {
    if (this.monitoring || this.child !== child || !this.desired) return;
    this.monitoring = true;
    try {
      if (!(await this.options.authReady())) throw new Error();
      const address = await this.ensureTunnel(secret, false);
      if (this.child === child && this.desired) this.state = { phase: "running", ...address };
    } catch {
      if (this.child === child) {
        await this.stop();
        if (!this.child) this.state = { phase: "failed", error: "playit-health-unverified" };
      }
    } finally {
      this.monitoring = false;
    }
  }
  stop(): Promise<TunnelStatus> {
    if (this.stopping) return this.stopping;
    this.stopping = this.stopOnce().finally(() => {
      this.stopping = undefined;
    });
    return this.stopping;
  }
  private async stopOnce(): Promise<TunnelStatus> {
    this.desired = false;
    if (this.retry) {
      clearTimeout(this.retry);
      this.retry = undefined;
    }
    if (this.monitor) {
      clearInterval(this.monitor);
      this.monitor = undefined;
    }
    await this.operation;
    const child = this.child;
    if (child) {
      const confirmed = await new Promise<boolean>((resolve) => {
        const deadline = setTimeout(() => {
          clearTimeout(killTimer);
          resolve(false);
        }, 10_000);
        const killTimer = setTimeout(() => {
          child.kill("SIGKILL");
        }, 5000);
        child.once("exit", () => {
          clearTimeout(killTimer);
          clearTimeout(deadline);
          resolve(true);
        });
        child.kill("SIGTERM");
      });
      if (!confirmed) {
        this.state = { phase: "failed", error: "playit-stop-unconfirmed" };
        return this.status();
      }
      this.child = undefined;
    }
    await this.cleanup;
    await rm(this.secretPath, { force: true });
    this.attempts = 0;
    this.state = { phase: "stopped" };
    return this.status();
  }
  private now(): number {
    return (this.options.now ?? Date.now)();
  }
}
