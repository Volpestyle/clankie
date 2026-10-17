import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { lstatSync } from "node:fs";
import { once } from "node:events";
import type { Socket } from "node:net";
import { serve } from "@hono/node-server";
import { FixtureCleanupUnresolvedError, type OwnedFixture } from "./fixture-admission-bootstrap.ts";
import {
  fixtureDigest,
  FixtureIssueSchema,
  FixtureVerifySchema,
  FIXTURE_VERIFY_PATH,
  readFixtureJson,
  type FixtureObservation,
} from "./fixture-admission-contract.ts";
import { nativeProcessStart, observeSocketProcess } from "./local-fleet-process.ts";
import { FixtureRequestIndex, type FixtureRequestRecord } from "./fixture-request-index.ts";
import type { ProjectProcessProof } from "./project-process-proof.ts";

export interface FixtureOriginalSubject {
  proof: ProjectProcessProof;
  controller: { pid: number; start: string; threadId: string; endpoint: string };
  projectId: string;
  workspace: string;
  hire: unknown;
  projectsRevision: string;
  hostUid: number;
  /** Full kernel observation, never reduced to a caller-authored PID. */
  originalObservation: FixtureObservation;
}
export interface FixtureOriginalVerifier {
  capture(proof: ProjectProcessProof, observation: FixtureObservation): Promise<FixtureOriginalSubject>;
  reprove(subject: FixtureOriginalSubject, observation: FixtureObservation): Promise<() => void>;
}
type Ticket = {
  ticketId: string;
  requestId: string;
  receiptId: string;
  bindingHash: string;
  issuer: string;
  expiresAt: number;
  subject: FixtureOriginalSubject;
  state: "issued" | "claimed" | "consumed";
  claimId?: string;
  revoked?: true;
  observation?: string;
  fixture: OwnedFixture;
  timer?: NodeJS.Timeout;
  closing?: Promise<void>;
  /** Set only once retirement verified the owned child gone and its root removed. */
  removed?: true;
};
const refusal = (error = "fixture_admission_refused", status = 403) => Response.json({ error }, { status });
const equalSecret = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** No tool/catalog/provider port. Callback listener is deliberately not LocalFleetLink. */
export class NativeFixtureAdmissions {
  private readonly issuer = randomUUID();
  private readonly tickets = new Map<string, Ticket>();
  private readonly index!: FixtureRequestIndex;
  /** Why fixture admission is refused on this host; the service itself keeps running. */
  readonly unavailable?: string;
  private readonly pending = new Set<string>();
  private listener?: ReturnType<typeof serve>;
  private listening?: Promise<string>;
  private closed = false;
  private issuanceDone?: Promise<void>;
  private issuanceCleanupFailure?: Error;
  private readonly options: {
    verifier: FixtureOriginalVerifier;
    bootstrap(callbackOrigin: string, expiresAt: number): Promise<OwnedFixture>;
    processHelper: string;
    stateRoot: string;
  };
  constructor(options: NativeFixtureAdmissions["options"]) {
    this.options = options;
    try {
      this.index = new FixtureRequestIndex(options.stateRoot);
    } catch (error) {
      this.unavailable = error instanceof Error ? error.message : String(error);
    }
  }

  /** Separate verify-only listener. Starting it grants no ticket or pane authority. */
  startCallbackListener(): Promise<string> {
    if (this.closed) return Promise.reject(new Error("Fixture admission controller closed"));
    return (this.listening ??= (async () => {
      this.listener = serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: (request, env) => this.handleCallback(request, env.incoming.socket),
      });
      if (!this.listener.listening) await once(this.listener, "listening");
      const address = this.listener.address();
      if (!address || typeof address === "string" || [4310, 4321].includes(address.port))
        throw new Error("Invalid callback origin");
      return `http://127.0.0.1:${address.port}`;
    })());
  }
  private subjectHash(subject: FixtureOriginalSubject): string {
    const { originalObservation: _observation, ...identity } = subject;
    return fixtureDigest(identity);
  }
  private persist(ticket: Ticket): void {
    this.index.update(ticket.requestId, this.issuer, {
      ticketId: ticket.ticketId,
      bindingHash: ticket.bindingHash,
      fixture: ticket.fixture.descriptor,
      uncertain: ticket.state !== "issued",
      state: ticket.state,
      claimId: ticket.claimId,
      observation: ticket.observation,
      revoked: ticket.revoked === true,
      expired: Date.now() >= ticket.expiresAt,
    });
  }
  private status(record: FixtureRequestRecord) {
    const { subjectHash: _subject, ...retained } = record;
    return {
      ...retained,
      expired: record.expired || Date.now() >= record.expiresAt,
      uncertain: record.uncertain || record.issuer !== this.issuer,
      priorHost: record.issuer !== this.issuer,
      statusOnly: true,
      nativeAccount: { status: "unavailable" },
      mayExecute: false,
    };
  }
  private async retire(ticket: Ticket, kind: "close" | "revoke" | "expire"): Promise<void> {
    if (ticket.closing) return ticket.closing;
    clearTimeout(ticket.timer);
    if (kind !== "expire") ticket.revoked = true;
    return (ticket.closing = (async () => {
      let failure: unknown;
      try {
        this.persist(ticket);
      } catch (error) {
        failure = error;
      }
      // An index write failure must not skip owned child shutdown/verified root cleanup.
      try {
        await ticket.fixture.close();
        this.index.update(ticket.requestId, this.issuer, { cleanup: "removed" });
        if (!failure) ticket.removed = true;
      } catch (error) {
        failure ??= error;
        try {
          this.index.update(ticket.requestId, this.issuer, { cleanup: "refused", uncertain: true });
        } catch {}
      }
      if (failure) throw failure;
    })());
  }
  async handleOriginal(
    request: Request,
    proof: ProjectProcessProof,
    socket: Socket,
    current: () => boolean,
  ): Promise<Response> {
    let owned: OwnedFixture | undefined;
    let finishIssue: (() => void) | undefined;
    let pendingId: string | undefined;
    try {
      if (this.closed || proof.nativeSessionPending || !proof.privateSeat) return refusal();
      if (this.unavailable)
        return Response.json(
          { error: "fixture_index_unavailable", reason: this.unavailable },
          { status: 503 },
        );
      const observation = await observeSocketProcess(socket, this.options.processHelper);
      if (!observation) return refusal("original_socket_unavailable");
      const subject = await this.options.verifier.capture(proof, observation);
      if (!current()) return refusal();
      const path = new URL(request.url).pathname;
      const suffix = path.split("/fixture-admissions")[1] ?? "invalid";
      if (suffix === "" && request.method === "POST") {
        const raw = await readFixtureJson(request);
        if (raw && typeof raw === "object" && "assurance" in raw && raw.assurance !== "host-seat/v1")
          return refusal("native_account_unavailable");
        const input = FixtureIssueSchema.parse(raw);
        const beforeReserve = await this.options.verifier.reprove(subject, observation);
        if (!current() || socket.destroyed || this.closed) return refusal();
        beforeReserve();
        const previous = this.index.find(input.requestId);
        if (previous) {
          if (previous.receiptId !== input.receiptId || previous.subjectHash !== this.subjectHash(subject))
            return refusal();
          return Response.json(this.status(previous)); // Every retained ID is status-only, including old hosts.
        }
        if (this.pending.size > 0) return refusal("issuance_uncertain", 409);
        const tickets = [...this.tickets.values()];
        if (tickets.some((ticket) => !ticket.revoked && Date.now() < ticket.expiresAt))
          return refusal("fixture_already_active", 409);
        // A revoked or expired fixture holds the fence until its child and root are verified gone;
        // refused cleanup keeps it blocked.
        if (tickets.some((ticket) => !ticket.removed)) return refusal("fixture_cleanup_pending", 409);
        const expiresAt = Date.now() + 60_000;
        const reserved = this.index.reserve({
          ...input,
          issuer: this.issuer,
          subjectHash: this.subjectHash(subject),
          expiresAt,
          state: "pending",
          uncertain: true,
          revoked: false,
          expired: false,
        });
        if (reserved.issuer !== this.issuer || reserved.expiresAt !== expiresAt)
          return Response.json(this.status(reserved));
        this.pending.add(input.requestId);
        pendingId = input.requestId;
        this.issuanceDone = new Promise<void>((resolve) => {
          finishIssue = resolve;
        });
        try {
          try {
            owned = await this.options.bootstrap(await this.startCallbackListener(), expiresAt);
          } catch (error) {
            // Its own launched child/root was not proven gone: keep the fence like any unresolved cleanup.
            if (error instanceof FixtureCleanupUnresolvedError) {
              this.issuanceCleanupFailure = error;
              try {
                this.index.update(input.requestId, this.issuer, { cleanup: "refused", uncertain: true });
              } catch {}
            }
            throw error;
          }
          this.index.update(input.requestId, this.issuer, { fixture: owned.descriptor, cleanup: "pending" });
          const final = await this.options.verifier.reprove(subject, observation);
          if (!current() || this.closed || Date.now() >= expiresAt) return refusal();
          final();
          const root = lstatSync(owned.descriptor.root, { bigint: true });
          const ticketId = randomUUID();
          const bindingHash = fixtureDigest({
            issuer: this.issuer,
            ticketId,
            ...input,
            subject,
            fixture: owned.descriptor,
            root: [String(root.dev), String(root.ino), String(root.birthtimeNs)],
          });
          const ticket: Ticket = {
            ticketId,
            ...input,
            bindingHash,
            issuer: this.issuer,
            expiresAt,
            subject,
            state: "issued",
            fixture: owned,
          };
          this.persist(ticket);
          this.index.update(input.requestId, this.issuer, { uncertain: false });
          final();
          if (!current()) return refusal();
          this.tickets.set(ticketId, ticket);
          ticket.timer = setTimeout(
            () => {
              void this.retire(ticket, "expire").catch(() => {});
            },
            Math.max(1, expiresAt - Date.now()),
          );
          ticket.timer.unref();
          owned = undefined;
          return Response.json(this.status(this.index.find(input.requestId)!), { status: 201 });
        } finally {
          if (owned) this.index.update(input.requestId, this.issuer, { uncertain: true });
        }
      }
      const lookup = /^\/requests\/([a-f0-9-]+)$/iu.exec(suffix);
      const match = /^\/([a-f0-9-]+)\/(status|revoke)$/iu.exec(suffix);
      if (!lookup && !match) return refusal("not_found", 404);
      const record = this.index.find(lookup?.[1], lookup ? undefined : match?.[1]);
      if (!record) return refusal("fixture_status_unknown_not_not_sent", 404);
      if (record.subjectHash !== this.subjectHash(subject)) return refusal();
      const ticket = record.ticketId ? this.tickets.get(record.ticketId) : undefined;
      const final = await this.options.verifier.reprove(ticket?.subject ?? subject, observation);
      if (!current() || this.closed) return refusal();
      final();
      if (match?.[2] === "revoke" && request.method === "POST") {
        if (record.issuer !== this.issuer || !ticket) return refusal("prior_host_status_only", 409);
        await this.retire(ticket, "revoke");
      } else if (request.method !== "GET") return refusal("method_not_allowed", 405);
      return Response.json(this.status(this.index.find(record.requestId)!));
    } catch {
      return refusal();
    } finally {
      try {
        if (owned) {
          try {
            await owned.close();
            if (pendingId) this.index.update(pendingId, this.issuer, { cleanup: "removed", uncertain: true });
          } catch (error) {
            this.issuanceCleanupFailure = new Error("Fixture issuance cleanup unresolved", { cause: error });
            if (pendingId) {
              try {
                this.index.update(pendingId, this.issuer, { cleanup: "refused", uncertain: true });
              } catch {}
            }
            /* Unknown ownership is preserved; durable request remains uncertain. */
          }
        }
      } finally {
        // Retain the single-issuance fence through owned cleanup and its durable finalization.
        // An unproven cleanup keeps admission blocked and makes host close fail honestly.
        if (pendingId && !this.issuanceCleanupFailure) this.pending.delete(pendingId);
        finishIssue?.();
      }
    }
  }

  async handleCallback(request: Request, socket: Socket): Promise<Response> {
    if (new URL(request.url).pathname !== FIXTURE_VERIFY_PATH || request.method !== "POST")
      return refusal("not_found", 404);
    try {
      const input = FixtureVerifySchema.parse(await readFixtureJson(request));
      const ticket = this.tickets.get(input.ticketId);
      if (
        !ticket ||
        this.closed ||
        ticket.issuer !== this.issuer ||
        ticket.revoked ||
        Date.now() >= ticket.expiresAt
      )
        return refusal();
      const retained = this.index.find(ticket.requestId);
      if (
        !retained ||
        retained.issuer !== this.issuer ||
        retained.revoked ||
        retained.expired ||
        retained.state !== ticket.state ||
        retained.bindingHash !== ticket.bindingHash
      )
        return refusal();
      const fixture = ticket.fixture;
      if (
        !equalSecret(request.headers.get("x-clankie-fixture-capability") ?? "", fixture.capability) ||
        input.fixtureId !== fixture.descriptor.fixtureId ||
        input.bindingHash !== ticket.bindingHash ||
        input.requestId !== ticket.requestId ||
        input.receiptId !== ticket.receiptId
      )
        return refusal();
      const peer = await observeSocketProcess(socket, this.options.processHelper);
      if (
        !peer ||
        peer.owner.pid !== fixture.descriptor.process.pid ||
        nativeProcessStart(peer.owner.birth, peer.owner.kernelIdentity) !==
          fixture.descriptor.process.start ||
        !(await fixture.assertCurrent())
      )
        return refusal("fixture_lifetime_refused");
      const final = await this.options.verifier.reprove(ticket.subject, input.observation);
      if (this.closed || ticket.revoked || Date.now() >= ticket.expiresAt || socket.destroyed)
        return refusal();
      final();
      let mayExecute = false;
      if (input.action === "claim") {
        if (ticket.state !== "issued") return refusal("ticket_already_claimed", 409);
        ticket.state = "claimed";
        ticket.claimId = input.claimId;
        ticket.observation = fixtureDigest(input.observation);
        this.persist(ticket);
        final();
      } else {
        if (ticket.claimId !== input.claimId) return refusal();
        if (input.action === "consume") {
          if (ticket.state !== "claimed" || ticket.observation !== fixtureDigest(input.observation))
            return refusal("ticket_already_consumed", 409);
          ticket.state = "consumed";
          this.persist(ticket);
          final();
          if (ticket.revoked || Date.now() >= ticket.expiresAt) return refusal();
          mayExecute = true;
        }
      }
      const verdict = {
        ...this.status(this.index.find(ticket.requestId)!),
        mayExecute,
        callbackNonce: input.callbackNonce,
        claimId: input.claimId,
      };
      const mac = createHmac("sha256", fixture.capability).update(JSON.stringify(verdict)).digest("hex");
      return Response.json({ verdict, mac });
    } catch {
      return refusal();
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    await this.issuanceDone;
    const results = await Promise.allSettled(
      [...this.tickets.values()].map((ticket) => this.retire(ticket, "close")),
    );
    if (this.listener) await new Promise<void>((resolve) => this.listener!.close(() => resolve()));
    if (this.issuanceCleanupFailure) throw this.issuanceCleanupFailure;
    const failed = results.find((r) => r.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }
}
