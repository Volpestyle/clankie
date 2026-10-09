import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { resolveProviderBearer, type CredentialStore } from "@clankie/credential-broker";
import {
  collectLinearImport,
  createLocalTracker,
  TRACKER_LEAD,
  TRACKER_OWNER,
  type TrackerActor,
  type LinearImportSnapshot,
} from "@clankie/work-items";
import { executeLinearGraphql, linearGraphqlCredential, planLinearGraphql } from "./linear-graphql.ts";
import { withLinearRequestInvocation, type LinearRequestBudget } from "./linear-request-budget.ts";
import type { EvidenceStore } from "./evidence-store.ts";

export interface LinearImportOptions {
  credentials: CredentialStore;
  budget: LinearRequestBudget;
  evidence: EvidenceStore;
  directory: string;
  ownerIds: readonly string[];
  ownerEmails: readonly string[];
  assertCurrent: () => Promise<void>;
}

/** Connected account only, shared service budget, read-only provider operations. */
export async function importConnectedLinear(projectId: string, options: LinearImportOptions) {
  let requests = 0;
  let expected: { workspaceId: string; userId: string } | undefined;
  const access = async () => {
    await options.assertCurrent();
    const selected = await linearGraphqlCredential(options.credentials);
    if (!selected) throw new Error("Import requires Clankie's connected Linear API app");
    const bearer = await resolveProviderBearer(selected.id, options.credentials, Date.now());
    const current = await linearGraphqlCredential(options.credentials);
    if (
      !bearer ||
      !current ||
      current.id !== selected.id ||
      current.credential.account?.workspaceId !== selected.credential.account?.workspaceId
    )
      throw new Error("Connected Linear account changed");
    if (
      expected &&
      (current.credential.account?.workspaceId !== expected.workspaceId ||
        current.credential.account?.userId !== expected.userId)
    )
      throw new Error("Linear account changed during import");
    return { bearer, credential: current.credential, id: current.id };
  };
  const first = await access();
  const binding = first.credential.account;
  if (!binding?.workspaceId || !binding.userId)
    throw new Error("Connected Linear app identity is not verified");
  expected = { workspaceId: binding.workspaceId, userId: binding.userId };
  const query = async (query: string, variables: Record<string, unknown>) => {
    const selected = await access();
    if (
      selected.credential.account?.workspaceId !== binding?.workspaceId ||
      selected.credential.account?.userId !== binding?.userId
    )
      throw new Error("Linear account changed during import");
    const plan = planLinearGraphql({ query, variables });
    if (plan.mutation) throw new Error("Linear import cannot mutate its source");
    const result = await withLinearRequestInvocation("background", () =>
      executeLinearGraphql({
        plan,
        ...selected,
        requestBudget: options.budget,
        signal: AbortSignal.timeout(30_000),
        dispatch: () => {
          requests++;
        },
      }),
    );
    const body = JSON.parse(result.content) as { data?: Record<string, unknown>; errors?: unknown };
    if (result.isError || !body.data)
      throw new Error(`Linear import query refused: ${JSON.stringify(body.errors)}`);
    return body.data;
  };
  const snapshot = await collectLinearImport({ projectId, query });
  if (snapshot.workspaceId !== binding?.workspaceId)
    throw new Error("Linear workspace did not match connected account");
  const actorMap: Record<string, TrackerActor> = {};
  for (const user of snapshot.actors) {
    const owner =
      options.ownerIds.includes(user.id) ||
      options.ownerEmails.some((email) => email.toLowerCase() === String(user.email).toLowerCase());
    actorMap[user.id] = owner
      ? { ...TRACKER_OWNER, name: String(user.name), onBehalfOf: [] }
      : user.id === binding?.userId
        ? { ...TRACKER_LEAD, onBehalfOf: [TRACKER_OWNER] }
        : user.isBotActor === true
          ? {
              type: "agent-worker",
              id: `linear:${user.id}`,
              name: String(user.name),
              onBehalfOf: [TRACKER_OWNER, TRACKER_LEAD],
            }
          : { type: "app", id: `linear:${user.id}`, name: String(user.name), onBehalfOf: [] };
  }
  const media = await importLinearMedia(snapshot, {
    ...options,
    access,
    dispatch: () => {
      requests++;
    },
  });
  const tracker = createLocalTracker({ directory: options.directory });
  const report = await tracker.importLinear(snapshot, actorMap, {
    actor: { ...TRACKER_LEAD, onBehalfOf: [TRACKER_OWNER] },
    beforeWrite: async () => {
      await access();
    },
  });
  report.skipped.push(...media.skipped);
  const result = {
    ...report,
    requests,
    attachments: media.count,
    actorMappings: actorMap,
    directory: options.directory,
  };
  await writeFile(join(options.directory, "import-report.json"), `${JSON.stringify(result, null, 2)}\n`, {
    mode: 0o600,
  });
  return result;
}

/** Never send the app bearer to arbitrary attachment URLs or follow redirects. */
function linearUploadUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      ["uploads.linear.app", "public.linear.app"].includes(url.hostname)
    );
  } catch {
    return false;
  }
}

async function importLinearMedia(
  snapshot: LinearImportSnapshot,
  options: LinearImportOptions & {
    access: () => Promise<{ bearer: string; credential: Parameters<LinearRequestBudget["fetch"]>[0] }>;
    dispatch: () => void;
  },
) {
  await mkdir(options.directory, { recursive: true, mode: 0o700 });
  const cachePath = join(options.directory, "linear-evidence.json");
  let cache: Record<string, { url: string; recordId: string }> = {};
  try {
    cache = JSON.parse(await readFile(cachePath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const skipped: { type: string; id: string; reason: string }[] = [];
  const urls = new Map<string, string | undefined>();
  const visit = (value: unknown, issueKey?: string) => {
    if (typeof value === "string")
      for (const match of value.matchAll(/https:\/\/(?:uploads|public)\.linear\.app\/[^\s<>)\]"\\]+/gu))
        urls.set(match[0], issueKey);
    else if (Array.isArray(value)) value.forEach((child) => visit(child, issueKey));
    else if (value && typeof value === "object")
      Object.values(value).forEach((child) => visit(child, issueKey));
  };
  for (const issue of snapshot.issues) visit(issue, String(issue.identifier));
  for (const key of ["comments", "documents", "projects", "milestones", "statusUpdates"] as const)
    for (const record of snapshot[key]) {
      visit(
        record,
        snapshot.issues.find((issue) => issue.id === record.issueId)?.identifier as string | undefined,
      );
    }
  for (const [url, issueKey] of urls) {
    if (cache[url]) {
      const record = await options.evidence.record(cache[url]!.recordId);
      if (!record) throw new Error("Imported evidence record is unavailable");
      await options.evidence.fetch({ sha256: record.sha256 });
      continue;
    }
    if (!linearUploadUrl(url)) throw new Error("Unsafe Linear upload URL");
    const selected = await options.access();
    const response = await withLinearRequestInvocation("background", () =>
      options.budget.fetch(
        selected.credential,
        fetch,
        url,
        {
          redirect: "error",
          headers: { authorization: `Bearer ${selected.bearer}` },
          signal: AbortSignal.timeout(30_000),
        },
        options.dispatch,
      ),
    );
    if (!response.ok) throw new Error(`Linear attachment download failed (HTTP ${response.status})`);
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (!response.body) throw new Error("Linear attachment has no body");
    const reader = response.body.getReader();
    while (true) {
      const { value: chunk, done } = await reader.read();
      if (done) break;
      size += chunk.byteLength;
      if (size > 128 * 1024 * 1024) {
        await reader.cancel();
        throw new Error("Linear attachment exceeds 128 MiB");
      }
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const actor = {
      kind: "operator" as const,
      id: "linear-import",
      name: "Clankie Linear import",
      onBehalfOf: [{ kind: "human", id: "owner" }],
    };
    const key = createHash("sha256").update(`${snapshot.workspaceId}:${url}:${sha256}`).digest("hex");
    const receipt = await options.evidence.upload(actor, {
      idempotencyKey: key,
      sha256,
      size,
      contentType: response.headers.get("content-type")?.split(";")[0] ?? "application/octet-stream",
      fileName: decodeURIComponent(new URL(url).pathname.split("/").at(-1) || sha256),
      ...(issueKey ? { issueKey } : {}),
      project: String(snapshot.projects[0]?.name),
      caption: "Imported from Linear",
    });
    if (receipt.state === "pending")
      await options.evidence.acceptBlob(
        EvidenceActorKey(actor),
        key,
        (async function* () {
          yield bytes;
        })(),
      );
    const settled = await options.evidence.lookup(actor, key);
    if (settled.state !== "applied" || !settled.recordId)
      throw new Error("Linear evidence upload did not settle");
    cache[url] = { url: settled.url, recordId: settled.recordId };
    const temporary = `${cachePath}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(cache, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, cachePath);
  }
  const rewrite = (value: unknown): unknown => {
    if (typeof value === "string") {
      let result = value;
      for (const [source, target] of Object.entries(cache)) result = result.replaceAll(source, target.url);
      return result;
    }
    if (Array.isArray(value)) return value.map(rewrite);
    if (value && typeof value === "object")
      return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, rewrite(child)]));
    return value;
  };
  for (const key of ["issues", "comments", "documents", "projects", "milestones", "statusUpdates"] as const) {
    for (const record of snapshot[key]) {
      const original = structuredClone(record);
      Object.assign(record, rewrite(record));
      if (JSON.stringify(original) !== JSON.stringify(record)) record.linearOriginal = original;
    }
  }
  // Non-upload attachments are references (GitHub links, etc.), not credentialed Linear blobs.
  for (const issue of snapshot.issues)
    for (const attachment of (issue.attachments ?? []) as Record<string, unknown>[])
      if (typeof attachment.url === "string" && !attachment.url.startsWith("clankie://evidence"))
        skipped.push({
          type: "attachment_download",
          id: String(attachment.id),
          reason: "External link retained; no Linear bearer sent",
        });
  return { count: urls.size, skipped };
}

// EvidenceStore uses this same canonical key for receipt ownership.
function EvidenceActorKey(actor: { kind: string; id: string }) {
  return `${actor.kind}:${actor.id}`;
}
