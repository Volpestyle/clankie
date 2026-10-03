/** Immutable trusted parent, outside the candidate namespace. No command runs on import. */
import { readdir, readFile, readlink } from "node:fs/promises";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { nativePermissionConfig } from "./lead-native-policy.mjs";
const HELPER = "/usr/local/lib/lead-coding-helper.mjs";
const NODE = "/usr/local/bin/node";
const MAX = 1024 * 1024 + 65536;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Pure provenance check over controller-read kernel rows; never candidate results. */
export function waitingHelper(rows, { pid, start, nonce, cwd, outerNamespace }) {
  const byId = new Map(rows.map((row) => [row.pid, row]));
  const root = byId.get(pid);
  if (!root || root.start !== start) throw Error("Owned sandbox launcher identity lost");
  const matches = rows.filter(
    (row) => row.argv.length === 2 && row.argv[0] === NODE && row.argv[1] === HELPER && row.nonce === nonce,
  );
  if (matches.length !== 1) throw Error("Exact waiting helper identity unavailable");
  const helper = matches[0];
  if (
    helper.exe !== NODE ||
    helper.cwd !== cwd ||
    !/^pid:\[[0-9]+\]$/u.test(helper.namespace) ||
    helper.namespace === outerNamespace
  )
    throw Error("Waiting helper execution boundary mismatch");
  const chain = [];
  let current = helper;
  while (current.pid !== pid) {
    if (chain.some((row) => row.pid === current.pid) || !byId.has(current.ppid))
      throw Error("Waiting helper ancestry unavailable");
    chain.push(current);
    current = byId.get(current.ppid);
  }
  chain.push(root);
  return {
    namespace: helper.namespace,
    helperPid: helper.pid,
    helperStart: helper.start,
    chain: chain.map(({ pid, start, ppid }) => ({ pid, start, ppid })),
  };
}
async function row(pid) {
  const stat = await readFile(`/proc/${pid}/stat`, "utf8");
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  const [argv, environment, exe, cwd, namespace] = await Promise.all([
    readFile(`/proc/${pid}/cmdline`),
    readFile(`/proc/${pid}/environ`),
    readlink(`/proc/${pid}/exe`),
    readlink(`/proc/${pid}/cwd`),
    readlink(`/proc/${pid}/ns/pid`),
  ]);
  return {
    pid,
    ppid: Number(fields[1]),
    start: fields[19],
    argv: argv.toString().split("\0").filter(Boolean),
    nonce: environment
      .toString()
      .split("\0")
      .find((entry) => entry.startsWith("LEAD_OPERATION_NONCE="))
      ?.slice("LEAD_OPERATION_NONCE=".length),
    exe,
    cwd,
    namespace,
  };
}
async function rows() {
  const result = [];
  for (const entry of await readdir("/proc")) {
    if (!/^[0-9]+$/u.test(entry)) continue;
    try {
      result.push(await row(Number(entry)));
    } catch (error) {
      if (!["ENOENT", "ESRCH"].includes(error.code)) throw error;
    }
  }
  return result;
}
async function namespaceGone(namespace) {
  for (const entry of await readdir("/proc")) {
    if (!/^[0-9]+$/u.test(entry)) continue;
    try {
      if ((await readlink(`/proc/${entry}/ns/pid`)) === namespace) return false;
    } catch (error) {
      if (!["ENOENT", "ESRCH"].includes(error.code)) throw error;
    }
  }
  return true;
}

export async function superviseCodingOperation(cwd, input) {
  const nonce = randomUUID();
  const config = nativePermissionConfig(cwd);
  const outerNamespace = await readlink("/proc/self/ns/pid");
  const child = spawn(
    "/opt/codex/bin/codex",
    [
      ...config.flatMap((value) => ["-c", value]),
      "sandbox",
      "linux",
      "--permission-profile",
      "lead_eval",
      "--cd",
      cwd,
      "--",
      NODE,
      HELPER,
    ],
    {
      cwd,
      env: {
        PATH: "/opt/codex/bin:/usr/local/bin:/usr/bin:/bin",
        HOME: "/tmp",
        CODEX_HOME: "/eval/control/coding-helper",
        LEAD_OPERATION_NONCE: nonce,
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let size = 0,
    error,
    closed = false;
  const output = [];
  child.stdin.on("error", (cause) => {
    error = cause;
  });
  child.stdout.on("data", (chunk) => {
    size += chunk.length;
    if (size > MAX) {
      error = Error("Bounded helper output exceeded");
      child.kill("SIGKILL");
    } else output.push(chunk);
  });
  child.stderr.on("data", (chunk) => {
    size += chunk.length;
    if (size > MAX) {
      error = Error("Bounded helper stderr exceeded");
      child.kill("SIGKILL");
    }
  });
  const exit = new Promise((resolve) => {
    child.once("error", (cause) => {
      error = cause;
      closed = true;
      resolve(null);
    });
    child.once("close", (code, signal) => {
      closed = true;
      resolve(signal ? null : code);
    });
  });
  const timer = setTimeout(() => {
    error = Error("Coding supervisor timeout");
    child.kill("SIGKILL");
  }, 25_000);
  try {
    if (!child.pid) throw Error("Sandbox launcher PID unavailable");
    const root = await row(child.pid);
    let proof;
    const until = Date.now() + 5000;
    while (!closed && !error && Date.now() < until) {
      const snapshot = await rows();
      if (snapshot.some((entry) => entry.nonce === nonce && entry.argv[1] === HELPER)) {
        proof = waitingHelper(snapshot, { pid: child.pid, start: root.start, nonce, cwd, outerNamespace });
        break;
      }
      await sleep(20);
    }
    if (!proof) throw Error("Waiting sandbox helper was not proven before command admission");
    for (const identity of proof.chain) {
      const actual = await row(identity.pid);
      if (actual.start !== identity.start || actual.ppid !== identity.ppid)
        throw Error("Sandbox ancestry changed before command admission");
    }
    const actual = await row(proof.helperPid);
    if (
      actual.namespace !== proof.namespace ||
      actual.nonce !== nonce ||
      actual.exe !== NODE ||
      actual.argv.join("\0") !== `${NODE}\0${HELPER}`
    )
      throw Error("Waiting helper changed before command admission");
    // No untrusted command reaches the namespace until kernel identity was recorded.
    child.stdin.end(input);
    const code = await exit;
    if (error || code !== 0) throw Error("Coding helper failed or lost exit status");
    const settleUntil = Date.now() + 2000;
    while (!(await namespaceGone(proof.namespace))) {
      if (Date.now() >= settleUntil) throw Error("Recorded sandbox namespace still has descendants");
      await sleep(20);
    }
    const result = JSON.parse(Buffer.concat(output).toString("utf8"));
    // Candidate/helper namespace text cannot select the settlement identity.
    delete result.namespace;
    return {
      result,
      settlement: {
        namespace: proof.namespace,
        helperPid: proof.helperPid,
        helperStart: proof.helperStart,
        complete: true,
      },
    };
  } finally {
    clearTimeout(timer);
    if (!closed) child.kill("SIGKILL");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > MAX) throw Error("Coding request exceeds bound");
      chunks.push(chunk);
    }
    process.stdout.write(
      JSON.stringify(await superviseCodingOperation(process.argv[2], Buffer.concat(chunks))),
    );
  } catch {
    process.stderr.write("Trusted coding supervisor refused execution/settlement\n");
    process.exitCode = 1;
  }
}
