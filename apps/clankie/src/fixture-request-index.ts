import {
  constants,
  closeSync,
  fsyncSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { saveFixtureState } from "./fixture-admission-bootstrap.ts";
import { FixtureDescriptorSchema } from "./fixture-admission-contract.ts";

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const RecordSchema = z
  .object({
    requestId: z.string().uuid(),
    receiptId: z.string().uuid(),
    subjectHash: hash,
    issuer: z.string().uuid(),
    assurance: z.literal("host-seat/v1"),
    expiresAt: z.number().int().positive(),
    state: z.enum(["pending", "issued", "claimed", "consumed"]),
    uncertain: z.boolean(),
    revoked: z.boolean(),
    expired: z.boolean(),
    ticketId: z.string().uuid().optional(),
    bindingHash: hash.optional(),
    claimId: z.string().uuid().optional(),
    observation: hash.optional(),
    fixture: FixtureDescriptorSchema.optional(),
    cleanup: z.enum(["pending", "removed", "refused"]).optional(),
  })
  .strict();
export type FixtureRequestRecord = z.infer<typeof RecordSchema>;
const IndexSchema = z.object({ version: z.literal(1), records: z.array(RecordSchema).max(4096) }).strict();
const identity = (path: string) => {
  const s = lstatSync(path, { bigint: true });
  return `${s.dev}:${s.ino}:${s.birthtimeNs}`;
};
const privateDirectory = (path: string) => {
  const s = lstatSync(path);
  if (
    realpathSync(path) !== path ||
    !s.isDirectory() ||
    s.uid !== process.getuid!() ||
    (s.mode & 0o077) !== 0
  )
    throw new Error("Unsafe fixture request index directory");
};
// The state root may be shared with other state (0755 by default): only this user may replace its entries.
const ownedParent = (path: string) => {
  const s = lstatSync(path);
  if (
    realpathSync(path) !== path ||
    !s.isDirectory() ||
    s.uid !== process.getuid!() ||
    (s.mode & 0o022) !== 0
  )
    throw new Error("Unsafe fixture request index parent");
};
const STAGED_ENTRY = /^index\.json(?:\.[0-9a-f-]{36}\.tmp)?$/u;

/** New host state only. No fixture-root recovery or historical receipt import. */
export class FixtureRequestIndex {
  private readonly directory: string;
  private readonly path: string;
  private readonly parentIdentity: string;
  private readonly directoryIdentity: string;
  private readonly stateRoot: string;
  constructor(stateRoot: string) {
    this.stateRoot = stateRoot;
    ownedParent(stateRoot);
    this.parentIdentity = identity(stateRoot);
    this.directory = join(stateRoot, "fixture-admission-requests");
    this.path = join(this.directory, "index.json");
    let absent = false;
    try {
      lstatSync(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      absent = true;
    }
    if (absent) this.publish();
    privateDirectory(this.directory);
    this.directoryIdentity = identity(this.directory);
    this.read(); // Never replace a missing/corrupt prior index; no migration/backfill.
  }
  /**
   * First use publishes the directory only once its empty index is durable, so an
   * interrupted first write leaves just the staging directory, which never held a record.
   */
  private publish() {
    const staging = join(this.stateRoot, "fixture-admission-requests.init");
    try {
      privateDirectory(staging);
      // Remove only what an interrupted first write creates; anything else is preserved and refused.
      const entries = readdirSync(staging);
      for (const entry of entries) {
        const s = lstatSync(join(staging, entry));
        if (
          !STAGED_ENTRY.test(entry) ||
          !s.isFile() ||
          s.nlink !== 1 ||
          s.uid !== process.getuid!() ||
          // A staged index is only ever the empty first one; any record would be prior state.
          (entry === "index.json" &&
            IndexSchema.parse(JSON.parse(readFileSync(join(staging, entry), "utf8"))).records.length !== 0)
        )
          throw new Error("Unknown fixture request index staging; preserved");
      }
      for (const entry of entries) unlinkSync(join(staging, entry));
      rmdirSync(staging);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    mkdirSync(staging, { mode: 0o700 });
    privateDirectory(staging);
    saveFixtureState(join(staging, "index.json"), { version: 1, records: [] });
    renameSync(staging, this.directory);
    const parent = openSync(
      this.stateRoot,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY,
    );
    try {
      const s = fstatSync(parent, { bigint: true });
      if (
        !s.isDirectory() ||
        s.uid !== BigInt(process.getuid!()) ||
        (s.mode & 0o022n) !== 0n ||
        `${s.dev}:${s.ino}:${s.birthtimeNs}` !== this.parentIdentity
      )
        throw new Error("Fixture request index parent changed before sync");
      fsyncSync(parent); // Persist the published index-directory entry in its validated parent.
    } finally {
      closeSync(parent);
    }
  }
  private assertDirectory() {
    ownedParent(this.stateRoot);
    privateDirectory(this.directory);
    if (
      identity(this.stateRoot) !== this.parentIdentity ||
      identity(this.directory) !== this.directoryIdentity
    )
      throw new Error("Fixture request index directory changed");
  }
  private read(): FixtureRequestRecord[] {
    this.assertDirectory();
    const fd = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let records: FixtureRequestRecord[];
    try {
      const s = fstatSync(fd);
      const linked = lstatSync(this.path);
      if (s.dev !== linked.dev || s.ino !== linked.ino || linked.isSymbolicLink())
        throw new Error("Fixture request index file changed");
      if (
        !s.isFile() ||
        s.nlink !== 1 ||
        s.uid !== process.getuid!() ||
        (s.mode & 0o077) !== 0 ||
        s.size > 8_000_000
      )
        throw new Error("Unsafe fixture request index file");
      records = IndexSchema.parse(JSON.parse(readFileSync(fd, "utf8"))).records;
    } finally {
      closeSync(fd);
    }
    const requests = new Set<string>(),
      receipts = new Set<string>(),
      tickets = new Set<string>();
    for (const record of records) {
      if (
        requests.has(record.requestId) ||
        receipts.has(record.receiptId) ||
        (record.ticketId && tickets.has(record.ticketId)) ||
        (record.state !== "pending" && (!record.ticketId || !record.bindingHash || !record.fixture)) ||
        (["claimed", "consumed"].includes(record.state) && (!record.claimId || !record.observation))
      )
        throw new Error("Ambiguous fixture request index");
      requests.add(record.requestId);
      receipts.add(record.receiptId);
      if (record.ticketId) tickets.add(record.ticketId);
    }
    this.assertDirectory();
    return records;
  }
  private transaction<T>(operation: (records: FixtureRequestRecord[]) => T): T {
    this.assertDirectory();
    const lock = join(this.directory, "writer.lock");
    // No stale-time takeover: an interrupted/unknown writer prevents mutations.
    mkdirSync(lock, { mode: 0o700 });
    const held = identity(lock);
    let result!: T;
    let failed = false,
      failure: unknown;
    try {
      const records = this.read();
      const before = JSON.stringify(records);
      result = operation(records);
      IndexSchema.parse({ version: 1, records });
      if (Buffer.byteLength(JSON.stringify({ version: 1, records })) > 8_000_000)
        throw new Error("Fixture request index full");
      this.assertDirectory();
      if (identity(lock) !== held) throw new Error("Fixture request index lock changed");
      if (JSON.stringify(records) !== before) saveFixtureState(this.path, { version: 1, records });
    } catch (error) {
      failed = true;
      failure = error;
    }
    try {
      this.assertDirectory();
      if (identity(lock) !== held) throw new Error("Fixture request index lock changed; preserved");
      rmdirSync(lock);
      const fd = openSync(this.directory, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    } catch (error) {
      if (failed)
        throw new AggregateError(
          [failure, error],
          "Fixture request transaction and lock release failed; preserved",
        );
      throw error;
    }
    if (failed) throw failure;
    return result;
  }
  find(requestId?: string, ticketId?: string): FixtureRequestRecord | undefined {
    return this.read().find((r) => (requestId ? r.requestId === requestId : r.ticketId === ticketId));
  }
  reserve(record: FixtureRequestRecord): FixtureRequestRecord {
    return this.transaction((records) => {
      const prior = records.find((r) => r.requestId === record.requestId);
      if (prior) {
        if (
          prior.receiptId !== record.receiptId ||
          prior.subjectHash !== record.subjectHash ||
          prior.assurance !== record.assurance
        )
          throw new Error("Fixture request identity mismatch");
        return prior;
      }
      if (records.some((r) => r.receiptId === record.receiptId) || records.length >= 4096)
        throw new Error("Fixture receipt reused or request index full");
      records.push(RecordSchema.parse(record));
      return record;
    });
  }
  update(requestId: string, issuer: string, change: Partial<FixtureRequestRecord>): FixtureRequestRecord {
    return this.transaction((records) => {
      const i = records.findIndex((r) => r.requestId === requestId);
      const prior = records[i];
      if (!prior || prior.issuer !== issuer) throw new Error("Prior host fixture requests are status-only");
      const next = RecordSchema.parse({ ...prior, ...change });
      if (
        ["requestId", "receiptId", "subjectHash", "issuer", "assurance", "expiresAt"].some(
          (key) => next[key as keyof typeof next] !== prior[key as keyof typeof prior],
        ) ||
        (prior.ticketId &&
          (next.ticketId !== prior.ticketId ||
            next.bindingHash !== prior.bindingHash ||
            JSON.stringify(next.fixture) !== JSON.stringify(prior.fixture))) ||
        (prior.fixture && JSON.stringify(next.fixture) !== JSON.stringify(prior.fixture)) ||
        (prior.claimId && (next.claimId !== prior.claimId || next.observation !== prior.observation)) ||
        ["pending", "issued", "claimed", "consumed"].indexOf(next.state) <
          ["pending", "issued", "claimed", "consumed"].indexOf(prior.state) ||
        (prior.revoked && !next.revoked) ||
        (prior.expired && !next.expired)
      )
        throw new Error("Immutable fixture request binding changed");
      records[i] = next;
      return next;
    });
  }
}
