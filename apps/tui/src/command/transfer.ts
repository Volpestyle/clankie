import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { parseArgs } from "node:util";
import { resolveOperatorCredential, type CredentialStore } from "@clankie/credential-broker";
import {
  BODY_TRANSFER_ABORT_PATH,
  BODY_TRANSFER_APPLY_PATH,
  BODY_TRANSFER_BUNDLE_PATH,
  BODY_TRANSFER_DISCARD_PATH,
  BODY_TRANSFER_FREEZE_PATH,
  BODY_TRANSFER_REBIND_PATH,
  BODY_TRANSFER_RECLAIM_PATH,
  BODY_TRANSFER_RELEASE_PATH,
  BODY_TRANSFER_STAGE_PATH,
  BODY_TRANSFER_STATUS_PATH,
  BodyAuthoritySchema,
  BodyTransferIdSchema,
  BodyTransferStageResultSchema,
  type BodyAuthority,
} from "@clankie/protocol/body-transfer";
import { commandHost, outputJson, type Writable } from "./io.ts";

const USAGE = `Usage:
  clankie transfer --to URL|local [--from URL|local] [--to-token-file FILE] [--from-token-file FILE]
                   [--destination-machine ID] [--replace] [--transfer-id UUID]
  clankie transfer status [--at URL|local] [--token-file FILE]
  clankie transfer abort --transfer-id UUID --to URL|local [--from URL|local] [token files]
  clankie transfer reclaim --force --reason TEXT [--at URL|local] [--token-file FILE]
  clankie transfer rebind --transfer-id UUID --machine ID [--at URL|local] [--token-file FILE]`;

export interface TransferCommandOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly host?: string;
  readonly fetchImpl?: typeof fetch;
  readonly operatorCredentialStore?: CredentialStore;
  readonly stderr?: Writable;
  /** Seconds between polls while a body restarts; tests shorten it. */
  readonly pollSeconds?: number;
}

interface Endpoint {
  readonly label: string;
  readonly url: string;
  readonly token: string;
}

/**
 * Moves Clankie between bodies with the owner's operator authority on both
 * (ADR 0286). Every step is repeatable with the same transfer id; a failure
 * leaves the source frozen, never active alongside the destination.
 */
export async function runTransferCommand(
  args: readonly string[],
  stdout: Writable,
  options: TransferCommandOptions = {},
): Promise<number> {
  const action = ["status", "abort", "reclaim", "rebind"].includes(args[0] ?? "") ? args[0]! : "move";
  const { values } = parseArgs({
    args: action === "move" ? [...args] : args.slice(1),
    options: {
      to: { type: "string" },
      from: { type: "string" },
      at: { type: "string" },
      "to-token-file": { type: "string" },
      "from-token-file": { type: "string" },
      "token-file": { type: "string" },
      "destination-machine": { type: "string" },
      "transfer-id": { type: "string" },
      machine: { type: "string" },
      reason: { type: "string" },
      replace: { type: "boolean" },
      force: { type: "boolean" },
    },
    strict: true,
  });
  const fetcher = options.fetchImpl ?? fetch;
  const stderr = options.stderr ?? process.stderr;
  const pollMs = (options.pollSeconds ?? 2) * 1000;
  const endpoint = async (target: string | undefined, tokenFile: string | undefined): Promise<Endpoint> => {
    if (target === undefined || target === "local") {
      const env = options.env ?? process.env;
      const credential = await resolveOperatorCredential({
        env,
        ...(options.operatorCredentialStore === undefined ? {} : { store: options.operatorCredentialStore }),
      });
      if (!credential?.token)
        throw new Error("No operator credential is available for this machine's Clankie");
      return { label: `local:${hostname()}`, url: commandHost({ ...options, env }), token: credential.token };
    }
    const url = new URL(target);
    if (tokenFile === undefined) throw new Error(`${target} needs a token file with its operator credential`);
    const token = (await readFile(tokenFile, "utf8")).trim();
    if (token.length === 0) throw new Error(`${tokenFile} is empty`);
    return { label: url.origin, url: url.origin, token };
  };
  const call = async (at: Endpoint, path: string, init: RequestInit & { duplex?: "half" } = {}) => {
    const response = await fetcher(new URL(path, at.url), {
      ...init,
      headers: { authorization: `Bearer ${at.token}`, "content-type": "application/json", ...init.headers },
    });
    if (!response.ok) {
      const text = await response.text();
      let code = text;
      try {
        code = (JSON.parse(text) as { error?: string }).error ?? text;
      } catch {
        /* Keep the raw text. */
      }
      throw new TransferRefused(at.label, path, response.status, code);
    }
    return response;
  };
  const status = async (at: Endpoint): Promise<BodyAuthority> =>
    BodyAuthoritySchema.loose().parse(await (await call(at, BODY_TRANSFER_STATUS_PATH)).json());
  const post = async (at: Endpoint, path: string, body: unknown) =>
    (await call(at, path, { method: "POST", body: JSON.stringify(body) })).json();
  // A body restarts after freeze and apply; wait until it answers in the expected state.
  const waitFor = async (at: Endpoint, what: string, ready: (self: BodyAuthority) => boolean) => {
    let told = false;
    for (let attempt = 0; attempt < 600_000 / pollMs; attempt++) {
      try {
        const self = await status(at);
        if (ready(self)) return self;
      } catch (error) {
        if (error instanceof TransferRefused && error.status !== 503) throw error;
      }
      if (!told) {
        stderr.write(
          `Waiting for ${at.label} to ${what}. If nothing supervises it, start it with \`clankie start\`.\n`,
        );
        told = true;
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    throw new Error(`${at.label} did not ${what} within ten minutes; rerun with the same --transfer-id`);
  };

  if (action === "status") {
    outputJson(stdout, await status(await endpoint(values.at, values["token-file"])));
    return 0;
  }
  if (action === "reclaim") {
    if (!values.force || !values.reason)
      throw new Error("reclaim needs --force and --reason: work the other body did will not be merged");
    const at = await endpoint(values.at, values["token-file"]);
    outputJson(stdout, await post(at, BODY_TRANSFER_RECLAIM_PATH, { force: true, reason: values.reason }));
    return 0;
  }
  if (action === "rebind") {
    if (!values["transfer-id"] || !values.machine) throw new Error(USAGE);
    const at = await endpoint(values.at, values["token-file"]);
    outputJson(
      stdout,
      await post(at, BODY_TRANSFER_REBIND_PATH, {
        transferId: values["transfer-id"],
        machineId: values.machine,
      }),
    );
    return 0;
  }
  if (!values.to) throw new Error(USAGE);
  const source = await endpoint(values.from, values["from-token-file"]);
  const destination = await endpoint(values.to, values["to-token-file"]);
  if (source.url === destination.url) throw new Error("Source and destination are the same body");
  if (action === "abort") {
    const transferId = BodyTransferIdSchema.parse(values["transfer-id"]);
    const discarded = await post(destination, BODY_TRANSFER_DISCARD_PATH, { transferId });
    outputJson(stdout, await post(source, BODY_TRANSFER_ABORT_PATH, { transferId, discarded }));
    return 0;
  }

  const transferId = BodyTransferIdSchema.parse(values["transfer-id"] ?? randomUUID());
  stderr.write(
    `Transfer ${transferId}: ${source.label} → ${destination.label}. Resume with --transfer-id ${transferId}.\n`,
  );
  let from = await status(source);
  let to = await status(destination);
  const outgoing = from.transfers?.[transferId];
  const incoming = to.transfers?.[transferId];
  if (outgoing === undefined) {
    for (;;) {
      try {
        await post(source, BODY_TRANSFER_FREEZE_PATH, {
          transferId,
          destination: destination.label,
          ...(values["destination-machine"] === undefined
            ? {}
            : { destinationMachineId: values["destination-machine"] }),
        });
        break;
      } catch (error) {
        if (!(error instanceof TransferRefused) || error.code !== "body_busy") throw error;
        stderr.write(`${source.label} is busy (a turn, call or share is running); retrying.\n`);
        await new Promise((resolve) => setTimeout(resolve, pollMs * 2));
      }
    }
  } else if (outgoing.role !== "source")
    throw new Error(`${transferId} is not an outgoing transfer at ${source.label}`);
  if (from.transfers?.[transferId]?.outcome !== "released") {
    from = await waitFor(
      source,
      "restart dormant",
      (self) => self.dormant && self.transferId === transferId && self.state === "frozen",
    );
  }
  if (incoming?.outcome !== "applied" && incoming?.outcome !== "applying") {
    const directory = await mkdtemp(join(tmpdir(), "clankie-transfer-"));
    try {
      const bundle = join(directory, "bundle");
      const download = await call(source, `${BODY_TRANSFER_BUNDLE_PATH}?transferId=${transferId}`);
      await pipeline(
        Readable.fromWeb(download.body! as import("node:stream/web").ReadableStream),
        createWriteStream(bundle, { mode: 0o600 }),
      );
      const staged = BodyTransferStageResultSchema.parse(
        await (
          await call(
            destination,
            `${BODY_TRANSFER_STAGE_PATH}?transferId=${transferId}${values.replace ? "&replace=1" : ""}`,
            {
              method: "POST",
              body: Readable.toWeb(createReadStream(bundle)) as ReadableStream,
              duplex: "half",
              headers: { "content-type": "application/octet-stream" },
            },
          )
        ).json(),
      );
      stderr.write(`Staged ${staged.files} files (${staged.bytes} bytes) at ${destination.label}.\n`);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    await post(destination, BODY_TRANSFER_APPLY_PATH, { transferId });
  }
  to = await waitFor(
    destination,
    "restart as Clankie",
    (self) => !self.dormant && self.state === "active" && self.transferId === transferId,
  );
  from = BodyAuthoritySchema.parse(
    await post(source, BODY_TRANSFER_RELEASE_PATH, {
      transferId,
      destination: destination.label,
      activation: { ...to, transfers: undefined },
    }),
  );
  outputJson(stdout, {
    transferId,
    source: { at: source.label, ...from },
    destination: { at: destination.label, ...to, transfers: undefined },
    next: [
      "Credentials and paired devices did not move: pair devices and connect accounts on this body if it lacks them.",
      `To keep running workers on the old machine, join it here (clankie join), then: clankie transfer rebind --transfer-id ${transferId} --machine JOINED_MACHINE_ID`,
    ],
  });
  return 0;
}

class TransferRefused extends Error {
  readonly at: string;
  readonly path: string;
  readonly status: number;
  readonly code: string;

  constructor(at: string, path: string, status: number, code: string) {
    super(`${at} refused ${path} (${status}): ${code}`);
    this.at = at;
    this.path = path;
    this.status = status;
    this.code = code;
  }
}
