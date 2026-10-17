import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, lstat } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
  FixtureDescriptorSchema,
  FixtureReadSchema,
  FixtureIssueSchema,
  fixtureOrigin,
} from "../../../clankie/src/fixture-admission-contract.ts";
import { nativeProcessStart, observeNativeBirth } from "../../../clankie/src/local-fleet-process.ts";

const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
async function privateBytes(path: string): Promise<Buffer> {
  if ((await realpath(path)) !== path) throw new Error("Fixture alias refused");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid!() ||
      (stat.mode & 0o077) !== 0 ||
      stat.size > 32_000_000
    )
      throw new Error("Private fixture input required");
    return await file.readFile();
  } finally {
    await file.close();
  }
}
export async function runFixtureAdmission(
  args: readonly string[],
  options: {
    repoRoot: string;
    env?: NodeJS.ProcessEnv;
  },
): Promise<unknown> {
  const command = args[0],
    flags = new Map<string, string>();
  for (let index = 1; index < args.length; index += 2) {
    const flag = args[index],
      value = args[index + 1];
    if (!flag?.startsWith("--") || !value || value.startsWith("--") || flags.has(flag))
      throw new Error("Invalid fixture flags");
    flags.set(flag, value);
  }
  const take = (name: string) => {
    const value = flags.get(name);
    flags.delete(name);
    return value;
  };
  const requestId = take("--request-id"),
    receiptId = take("--receipt-id"),
    ticketId = take("--ticket-id");
  const send = async (url: string, body?: unknown, headers?: Record<string, string>) => {
    const response = await fetch(url, {
      method: body === undefined ? "GET" : "POST",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
      headers: { "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result: unknown = await response.json();
    if (!response.ok) throw new Error(`Fixture request refused (${response.status})`);
    return result;
  };
  if (command === "read" || command === "read-status") {
    // This branch has no authority discovery, commandHost, default URL or caller origin option.
    const file = take("--fixture");
    const input = FixtureReadSchema.parse({
      requestId,
      receiptId,
      ticketId,
      claimId: take("--claim-id"),
      bindingHash: take("--binding"),
    });
    if (!file || flags.size) throw new Error("Pinned --fixture and exact read flags required");
    const descriptor = FixtureDescriptorSchema.parse(JSON.parse((await privateBytes(file)).toString("utf8")));
    const root = await lstat(descriptor.root);
    if (
      file !== join(descriptor.root, "fixture.json") ||
      (await realpath(descriptor.root)) !== descriptor.root ||
      !root.isDirectory() ||
      root.uid !== process.getuid!() ||
      (root.mode & 0o077) !== 0 ||
      Date.now() >= descriptor.expiresAt ||
      digest(await privateBytes(join(descriptor.root, "worker.mjs"))) !== descriptor.sourceDigest ||
      digest(await privateBytes(join(descriptor.root, "native-process-proof"))) !== descriptor.helperDigest
    )
      throw new Error("Fixture binding changed");
    const birth = await observeNativeBirth(
      descriptor.process.pid,
      undefined,
      join(descriptor.root, "native-process-proof"),
    );
    if (!birth || nativeProcessStart(birth) !== descriptor.process.start)
      throw new Error("Fixture process unavailable");
    return send(`${descriptor.origin}/v1/fixture/reads${command === "read-status" ? "/status" : ""}`, input);
  }
  if (!["request", "status", "revoke"].includes(command ?? ""))
    throw new Error("Unknown fixture admission command");
  let payload: unknown;
  let suffix = "";
  if (command === "request")
    payload = FixtureIssueSchema.parse({ requestId, receiptId, assurance: take("--assurance") });
  else if (command === "status") {
    if (!!ticketId === !!requestId || receiptId) throw new Error("One status identifier required");
    suffix = ticketId
      ? `/${z.string().uuid().parse(ticketId)}/status`
      : `/requests/${z.string().uuid().parse(requestId)}`;
  } else {
    if (receiptId) throw new Error("Unexpected receipt ID");
    suffix = `/${z.string().uuid().parse(ticketId)}/revoke`;
    payload = { requestId: z.string().uuid().parse(requestId) };
  }
  if (flags.size) throw new Error("Unknown fixture authority flags");
  // Only original-facing operations may resolve the existing native authority descriptor.
  const env = options.env ?? process.env;
  const linkModule = await import(
    pathToFileURL(join(options.repoRoot, "integrations/claude-plugin/worker/bin/link.mjs")).href
  );
  const link = linkModule.readLink(env.HERDR_SOCKET_PATH, env) as
    | { authentication?: string; url?: string }
    | undefined;
  if (link?.authentication !== "local-process") throw new Error("Original local native authority required");
  const origin = fixtureOrigin.parse(link.url),
    pane = env.HERDR_PANE_ID;
  if (!pane) throw new Error("Original pane selector unavailable");
  return send(`${origin}/v1/fleet/seats/${encodeURIComponent(pane)}/fixture-admissions${suffix}`, payload, {
    "x-clankie-pane": pane,
  });
}
