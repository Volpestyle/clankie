/**
 * `clankie telemetry ship` — sends a hosted body's telemetry spool to
 * CloudWatch Logs. The tenant host runs it from the pinned image with host
 * networking, the spool read-only and its own cursor directory; the body
 * itself never holds AWS credentials. Tenant and instance come from the
 * instance metadata service, never from the spool.
 */
import {
  createCloudWatchLogSink,
  createInstanceMetadata,
  shipSpool,
  type AwsCredentials,
  type ShipResult,
} from "@clankie/observability/body-telemetry-shipper";

const TELEMETRY_USAGE =
  "Usage: clankie telemetry ship --spool DIR --cursor FILE --log-group NAME [--once] [--interval SECONDS]";
const LOG_GROUP = /^[A-Za-z0-9_./#-]{1,512}$/u;
const CREDENTIAL_REFRESH_MS = 5 * 60_000;

interface ShipArgs {
  readonly spool: string;
  readonly cursor: string;
  readonly logGroup: string;
  readonly once: boolean;
  readonly intervalMs: number;
}

function parseTelemetryArgs(args: readonly string[]): ShipArgs {
  if (args[0] !== "ship") throw new Error(TELEMETRY_USAGE);
  const values = new Map<string, string>();
  let once = false;
  for (let index = 1; index < args.length; index += 1) {
    const flag = args[index] ?? "";
    if (flag === "--once") {
      once = true;
      continue;
    }
    const value = args[index + 1];
    if (!["--spool", "--cursor", "--log-group", "--interval"].includes(flag) || value === undefined) {
      throw new Error(TELEMETRY_USAGE);
    }
    values.set(flag, value);
    index += 1;
  }
  const spool = values.get("--spool");
  const cursor = values.get("--cursor");
  const logGroup = values.get("--log-group");
  const interval = Number(values.get("--interval") ?? "60");
  if (spool === undefined || cursor === undefined || logGroup === undefined || !LOG_GROUP.test(logGroup)) {
    throw new Error(TELEMETRY_USAGE);
  }
  if (!Number.isInteger(interval) || interval < 10 || interval > 3_600) throw new Error(TELEMETRY_USAGE);
  return { spool, cursor, logGroup, once, intervalMs: interval * 1000 };
}

export async function runTelemetryCommand(
  args: readonly string[],
  options: {
    readonly stdout: { write(chunk: string): unknown };
    readonly stderr: { write(chunk: string): unknown };
    readonly fetchImpl?: typeof fetch;
    readonly signal?: AbortSignal;
  },
): Promise<number> {
  let parsed: ShipArgs;
  try {
    parsed = parseTelemetryArgs(args);
  } catch (error) {
    options.stderr.write(`${error instanceof Error ? error.message : TELEMETRY_USAGE}\n`);
    return 2;
  }
  const metadata = createInstanceMetadata(options.fetchImpl);
  let identity: Awaited<ReturnType<typeof metadata.identity>>;
  try {
    identity = await metadata.identity();
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unreachable";
    options.stderr.write(
      `telemetry ship: instance metadata failed (${reason}); run it on the EC2 host with host networking\n`,
    );
    return 1;
  }
  let cached: AwsCredentials | undefined;
  const credentials = async () => {
    if (cached === undefined || (cached.expiresAtMs ?? 0) - Date.now() < CREDENTIAL_REFRESH_MS) {
      cached = await metadata.credentials();
    }
    return cached;
  };
  const sink = createCloudWatchLogSink({
    region: identity.region,
    logGroup: parsed.logGroup,
    credentials,
    ...(options.fetchImpl === undefined ? {} : { fetch: options.fetchImpl }),
  });
  const ship = () => shipSpool({ spoolDir: parsed.spool, cursorPath: parsed.cursor, identity, sink });
  const report = (result: ShipResult) => options.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
  if (parsed.once) {
    report(await ship());
    return 0;
  }
  const stop = options.signal ?? stopSignal();
  while (!stop.aborted) {
    try {
      report(await ship());
    } catch (error) {
      // A failed put keeps its cursor; the next interval retries the same lines.
      options.stderr.write(
        `${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "ship failed" })}\n`,
      );
    }
    await new Promise<void>((wake) => {
      const timer = setTimeout(wake, parsed.intervalMs);
      stop.addEventListener("abort", () => (clearTimeout(timer), wake()), { once: true });
    });
  }
  // One last pass so a stopping host flushes what the body wrote on its way down.
  report(await ship().catch(() => ({ shipped: 0, dropped: 0, files: 0 })));
  return 0;
}

function stopSignal(): AbortSignal {
  const controller = new AbortController();
  process.once("SIGTERM", () => controller.abort());
  process.once("SIGINT", () => controller.abort());
  return controller.signal;
}
