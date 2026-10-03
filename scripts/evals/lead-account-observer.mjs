/** Manual-only controller account observer. Import/construction never starts a native process. */
import { createHash } from "node:crypto";
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  watch,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { Duplex } from "node:stream";
import { CodexAppServerClient, openCodexSocket } from "../../apps/clankie/src/captain/codex-app-server.ts";
import { LeadContainer } from "./lead-containment.mjs";
import { nativeRuntimeEvidence } from "./lead-native-capability.mjs";
import {
  nativePermissionConfig,
  validateNativeLaunchState,
  validateEffectiveNativeConfig,
} from "./lead-native-policy.mjs";
import { CodexAccountSource } from "./lead-native-ledger.mjs";

const origins = new WeakMap();
const observations = new WeakMap();
export function consumeObserverSnapshot(snapshot) {
  const observer = observations.get(snapshot);
  if (!observer || !origins.has(observer)) throw Error("Fresh controller-observed account snapshot required");
  observations.delete(snapshot);
  return observer;
}
const CODEX = "/opt/codex/bin/codex";
const NODE = "/usr/local/bin/node";
const digest = (value) => createHash("sha256").update(value).digest("hex");
const clean = (environment, argv) => [
  "/usr/bin/env",
  "-i",
  ...Object.entries(environment).map(([key, value]) => `${key}=${value}`),
  ...argv,
];

function privateDirectory(path) {
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    realpathSync(path) !== path ||
    stat.uid !== process.getuid() ||
    stat.mode & 0o077
  )
    throw Error("Observer requires a canonical controller-owned private directory");
}

/** File contents are credentials only; decoded labels never attest account identity. */
function readCredential(accountHome) {
  privateDirectory(accountHome);
  const file = join(accountHome, "auth.json");
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.uid !== process.getuid() ||
      before.mode & 0o077 ||
      before.size > 1024 * 1024
    )
      throw Error("Observer auth material is not a protected regular file");
    const bytes = readFileSync(fd);
    const after = fstatSync(fd);
    const named = lstatSync(file);
    if (
      named.isSymbolicLink() ||
      named.dev !== before.dev ||
      named.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    )
      throw Error("Observer auth material changed during read");
    let auth;
    try {
      auth = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw Error("Observer credential format unavailable");
    }
    if (
      auth.auth_mode !== "chatgpt" ||
      typeof auth.tokens?.access_token !== "string" ||
      !auth.tokens.access_token ||
      auth.OPENAI_API_KEY != null
    )
      throw Error("Observer requires selected subscription credential material");
    return {
      accessToken: auth.tokens.access_token,
      sha256: digest(bytes),
      identity: `${before.dev}:${before.ino}:${before.uid}:${before.mode}:${before.nlink}:${before.mtimeMs}:${before.ctimeMs}`,
    };
  } finally {
    closeSync(fd);
  }
}

export function assertLeadAccountObserver(observer) {
  const origin = origins.get(observer);
  if (!origin) throw Error("Controller-origin account observer required");
  return observer;
}
export function observerCredential(observer) {
  assertLeadAccountObserver(observer);
  return origins.get(observer).selectedCredential();
}

export function createLeadAccountObserver({
  container,
  allocation,
  observerSlot = "lead-observer",
  now = Date.now,
  intervalMs = 1000,
  maxAgeMs = 5000,
  onStop = () => {},
  onSnapshot = async () => {},
  startupTimeoutMs = 30000,
}) {
  if (
    !(container instanceof LeadContainer) ||
    container.role !== "native" ||
    !/^[a-f0-9]{64}$/u.test(container.id ?? "")
  )
    throw Error("Exact controller-created native container required");
  const pinned = nativeRuntimeEvidence(container.capability);
  if (!/^[a-f0-9]{64}$/u.test(pinned.binaries?.[CODEX] ?? ""))
    throw Error("Pinned native observer binary unavailable");
  const selected = Object.freeze({ ...allocation });
  const { hostCwd, containerCwd, accountHome, accountId, email } = selected;
  const taskSlot = containerCwd?.split("/").at(-1);
  if (
    !/^[-a-zA-Z0-9]{1,64}$/u.test(taskSlot ?? "") ||
    !/^[a-z][a-z0-9-]{0,63}$/u.test(observerSlot) ||
    hostCwd !== join(container.root, "tasks", taskSlot) ||
    containerCwd !== `/eval/tasks/${taskSlot}` ||
    !accountId ||
    !email ||
    !Number.isSafeInteger(intervalMs) ||
    intervalMs < 10 ||
    !Number.isSafeInteger(maxAgeMs) ||
    maxAgeMs <= intervalMs ||
    !Number.isSafeInteger(startupTimeoutMs) ||
    startupTimeoutMs < maxAgeMs ||
    startupTimeoutMs > 60000
  )
    throw Error("Exact lead observer allocation and bounded watchdog required");
  const authRelative = relative(container.root, accountHome);
  if (
    !authRelative.startsWith("control/") ||
    authRelative.split("/").includes("..") ||
    realpathSync(accountHome) !== accountHome
  )
    throw Error("Lead auth home is outside protected controller storage");
  const containerAccountHome = `/eval/${authRelative}`;
  if (selected.containerAccountHome !== undefined && selected.containerAccountHome !== containerAccountHome)
    throw Error("Lead auth host/container mapping mismatch");
  for (let path = accountHome; path !== container.root; path = dirname(path)) privateDirectory(path);
  const selectedAuth = readCredential(accountHome);
  const containerId = container.id;
  const slot = join(container.root, "control", observerSlot);
  const socketPath = `/eval/control/${observerSlot}/account.sock`;
  const environment = Object.freeze({
    PATH: "/opt/codex/bin:/usr/local/bin:/usr/bin:/bin",
    HOME: `/eval/control/${observerSlot}/home`,
    CODEX_HOME: containerAccountHome,
    LANG: "C.UTF-8",
  });
  const abort = new AbortController();
  const aborted = new Promise((_, reject) =>
    abort.signal.addEventListener("abort", () => reject(Error("Account observer stopped")), { once: true }),
  );
  void aborted.catch(() => {});
  let client,
    socket,
    timer,
    fileWatch,
    directoryWatch,
    stopping,
    started = false,
    ready = false,
    busy = false;
  let lastAt, lastSnapshot, configSha256, nativeIdentity;
  let reason;
  const latch = (why) => {
    if (reason !== undefined) return;
    reason = why;
    ready = false;
    let settled, rejected;
    stopping = new Promise((resolve, reject) => {
      settled = resolve;
      rejected = reject;
    });
    void stopping.catch(() => {});
    abort.abort();
    clearInterval(timer);
    fileWatch?.close();
    directoryWatch?.close();
    try {
      // Invoke before any containment await; a shared-run stop may reenter stop().
      void Promise.resolve(onStop(why)).catch(() => {});
    } catch {
      /* Exact containment remains mandatory. */
    }
    void Promise.resolve()
      .then(async () => {
        client?.close();
        socket?.close();
        const receipt = await container.stop("lead account observer stopped");
        if (receipt?.containerId !== containerId || receipt.stopped !== true)
          throw Error("Observer container stop unconfirmed");
        return { containerId, stopped: true };
      })
      .then(settled, rejected);
  };
  const fail = (why) => {
    latch(why);
    throw Error(why);
  };
  const checkCredential = () => {
    try {
      if (reason !== undefined) throw Error("Account observer stop latched");
      if (container.id !== containerId || container.stopped) throw Error("Observer containment changed");
      const current = readCredential(accountHome);
      if (current.sha256 !== selectedAuth.sha256 || current.identity !== selectedAuth.identity)
        throw Error("Observer selected credential changed");
      return current;
    } catch {
      return fail("Observer selected credential or containment changed");
    }
  };
  const assertReady = () => {
    if (reason !== undefined) throw Error("Account observer stop latched");
    checkCredential();
    if (!ready || lastAt === undefined) throw Error("Account observer is not ready");
    if (now() < lastAt || now() - lastAt > maxAgeMs) return fail("Account observer coverage expired");
  };
  const rpc = async (method, params) => {
    if (reason !== undefined || !client) throw Error("Account observer unavailable");
    if (
      !["account/read", "account/rateLimits/read", "config/read"].includes(method) ||
      (method === "account/read" && params.refreshToken !== false)
    )
      return fail("Account observer RPC outside read-only policy");
    checkCredential();
    const result = await client.request(method, params);
    if (reason !== undefined) throw Error("Account observer stop latched");
    checkCredential();
    return result;
  };
  const exactAccount = async () => {
    const response = await rpc("account/read", { refreshToken: false });
    if (response?.account?.type !== "chatgpt" || response.account.email !== email)
      return fail("Native account identity unavailable or changed");
    return digest(JSON.stringify(response.account));
  };
  const source = new CodexAccountSource(rpc, { accountId, email });
  const observe = async () => {
    try {
      checkCredential();
      const identity = await exactAccount();
      const configuration = await validateEffectiveNativeConfig(
        await rpc("config/read", { includeLayers: true, cwd: containerCwd }),
        { cwd: containerCwd, codexHome: containerAccountHome },
      );
      const snapshot = await source.snapshot(now);
      const afterConfiguration = await validateEffectiveNativeConfig(
        await rpc("config/read", { includeLayers: true, cwd: containerCwd }),
        { cwd: containerCwd, codexHome: containerAccountHome },
      );
      if (
        afterConfiguration.sha256 !== configuration.sha256 ||
        (await exactAccount()) !== identity ||
        (nativeIdentity !== undefined && nativeIdentity !== identity) ||
        (configSha256 !== undefined && configuration.sha256 !== configSha256)
      )
        return fail("Native account or configuration changed");
      const published = Object.freeze({
        ...snapshot,
        fiveHour: Object.freeze({ ...snapshot.fiveHour }),
        sevenDay: Object.freeze({ ...snapshot.sevenDay }),
      });
      observations.set(published, observer);
      await Promise.race([onSnapshot(published), aborted]);
      checkCredential();
      if (reason !== undefined) throw Error("Account observer stop latched");
      nativeIdentity = identity;
      configSha256 = configuration.sha256;
      lastAt = snapshot.atMs;
      lastSnapshot = Object.freeze({ ...snapshot });
      ready = true;
      return structuredClone(lastSnapshot);
    } catch {
      return fail("Trusted account observation failed");
    }
  };
  let serial = Promise.resolve();
  const snapshot = () => {
    const pending = serial.then(observe);
    serial = pending.catch(() => {});
    return Promise.race([pending, aborted]);
  };
  const selectedCredential = async () => {
    assertReady();
    await snapshot();
    assertReady();
    const credential = checkCredential();
    return Object.freeze({
      accountId,
      accessToken: credential.accessToken,
      bindingSha256: digest(
        JSON.stringify({
          accountId,
          auth: credential.sha256,
          nativeIdentity,
          configSha256,
          containerId,
          binary: pinned.binaries[CODEX],
        }),
      ),
    });
  };
  const loss = () => latch("Native account observer connection lost");
  const track = (child) => {
    child.once("error", loss);
    child.once("exit", loss);
    child.stderr?.resume();
    return child;
  };
  const start = async () => {
    if (started || reason !== undefined) throw Error("Account observer cannot restart");
    started = true;
    const startupAt = now();
    timer = setInterval(() => {
      try {
        checkCredential();
        if (!ready) {
          if (now() < startupAt || now() - startupAt > startupTimeoutMs)
            latch("Account observer startup coverage expired");
          return;
        }
        assertReady();
      } catch {
        return;
      }
      if (!busy) {
        busy = true;
        void snapshot()
          .catch(() => {})
          .finally(() => {
            busy = false;
          });
      }
    }, intervalMs);
    timer.unref();
    try {
      await validateNativeLaunchState({ root: container.root, hostCwd, accountHome });
      checkCredential();
      mkdirSync(slot, { mode: 0o700 });
      mkdirSync(join(slot, "home"), { mode: 0o700 });
      privateDirectory(slot);
      fileWatch = watch(join(accountHome, "auth.json"), () => latch("Observer selected credential changed"));
      directoryWatch = watch(accountHome, (_event, name) => {
        if (name === null || name.toString() === "auth.json") {
          try {
            checkCredential();
          } catch {}
        }
      });
      fileWatch.on("error", loss);
      directoryWatch.on("error", loss);
      const server = track(
        await container.pipe(
          clean(environment, [
            CODEX,
            "--cd",
            containerCwd,
            ...nativePermissionConfig(containerCwd).flatMap((value) => ["-c", value]),
            "app-server",
            "--listen",
            `unix://${socketPath}`,
          ]),
        ),
      );
      server.stdout?.resume();
      await container.exec(
        clean(environment, [
          NODE,
          "-e",
          'const fs=require("node:fs");const p=process.argv[1];const until=Date.now()+10000;const check=()=>{try{if(fs.lstatSync(p).isSocket())return;}catch{}if(Date.now()>until)process.exit(1);setTimeout(check,20)};check();',
          socketPath,
        ]),
        { timeoutMs: 11000 },
      );
      const relay = track(
        await container.pipe(clean(environment, [CODEX, "app-server", "proxy", "--sock", socketPath])),
      );
      const stream = Duplex.from({ writable: relay.stdin, readable: relay.stdout });
      stream.on("error", loss);
      socket = await openCodexSocket("ws://localhost/", stream);
      if (!socket) throw Error("Account observer socket unavailable");
      socket.once("close", loss);
      socket.once("error", loss);
      client = new CodexAppServerClient(
        socket,
        (event) => {
          if (event.method === "connection/closed" || event.method !== "account/rateLimits/updated") loss();
          else {
            void snapshot().catch(() => {});
          }
        },
        maxAgeMs,
      );
      await Promise.race([client.initialize(), aborted]);
      await snapshot();
      assertReady();
      return observer;
    } catch {
      latch("Account observer startup failed");
      await stopping;
      throw Error("Account observer startup failed");
    }
  };
  const observer = Object.freeze({
    start,
    snapshot,
    selectedCredential,
    assertReady,
    current: () => {
      try {
        assertReady();
        return true;
      } catch {
        return false;
      }
    },
    signal: abort.signal,
    stop: async () => {
      latch("Account observer closed");
      return stopping;
    },
    evidence: () => ({
      ready,
      stopped: reason !== undefined,
      containerId,
      accountId,
      ...(lastAt === undefined ? {} : { observedAtMs: lastAt }),
      ...(configSha256 === undefined ? {} : { configSha256 }),
      ...(nativeIdentity === undefined ? {} : { nativeIdentitySha256: nativeIdentity }),
      binarySha256: pinned.binaries[CODEX],
    }),
  });
  origins.set(observer, { selectedCredential });
  return observer;
}
