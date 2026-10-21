import {
  ReviewCandidateSchema,
  type ProjectReview,
  type ReviewCandidate,
  type ReviewLanding,
  type ReviewSeat,
  type ReviewSubmission,
  type ReviewVerdictInput,
  type ReviewWaiver,
  type ReviewWaiverInput,
} from "@clankie/protocol/reviews";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { occupantIdForHerdrSession } from "./herdr-census.ts";
import type { HerdrAgentSnapshot } from "./herdr-watch.ts";
import type { FleetSeatDelivery } from "./fleet-seat.ts";
import type { PeerSeatAuthority } from "./peer-seat-messages.ts";
import type { ConversationOwner } from "./conversation-owner.ts";

/** Settled candidates kept beyond this are pruned oldest first; their patches go with them. */
const CANDIDATE_LIMIT = 500;

export type ReviewRefusal = {
  readonly error:
    | "native_seat_required"
    | "invalid_patch"
    | "patch_id_mismatch"
    | "no_project"
    | "no_reviewer"
    | "unknown_candidate"
    | "not_reviewer"
    | "already_decided"
    | "superseded"
    | "store_unavailable";
  readonly detail: string;
};

export interface ReviewGateOptions {
  readonly path: string;
  /** The review setting of a project, read fresh on every decision. */
  review(projectId: string): Promise<ProjectReview | undefined>;
  /** The native seat at this pane, from Herdr, for proof checks. */
  seat(paneId: string): Promise<HerdrAgentSnapshot | undefined>;
  /** The native seat with this terminal ID, wherever it now sits. */
  resolve(seatId: string): Promise<HerdrAgentSnapshot | undefined>;
  /** The project a seat's own checkout belongs to. */
  seatProject(agent: HerdrAgentSnapshot): Promise<string | undefined>;
  /** The project a local checkout directory belongs to. */
  directoryProject(directory: string): Promise<string | undefined>;
  /** Live seats that currently hold the project's reviewer setting. */
  reviewers(projectId: string, review: ProjectReview): Promise<readonly HerdrAgentSnapshot[]>;
  /** The lead that hired this seat; absent for a hand-started seat. May throw for a replaced occupant. */
  lead(agent: HerdrAgentSnapshot): ConversationOwner | undefined;
  deliver(seatId: string, text: string, conversationId: string | undefined): Promise<FleetSeatDelivery>;
  /** A service notice to a lead (the owner's default conversation when absent); never a relay. */
  notifyLead(owner: ConversationOwner | undefined, text: string): Promise<void>;
  /** The fleet room's record of each exchange. */
  room?(event: {
    readonly id: string;
    readonly kind: "candidate" | "verdict" | "waiver";
    readonly from: ReviewSeat | { readonly actor: "owner" | "lead"; readonly conversationId?: string };
    readonly to?: ReviewSeat;
    readonly text: string;
  }): void;
}

/** `git patch-id --verbatim` over exact diff bytes; `empty` for no change. */
function reviewPatchId(patch: Buffer, cwd?: string): string {
  if (!patch.length) return "empty";
  const result = spawnSync("git", ["patch-id", "--verbatim"], {
    input: patch,
    encoding: "utf8",
    ...(cwd === undefined ? {} : { cwd }),
  });
  if (result.status !== 0) throw new Error(`git patch-id failed: ${result.stderr.trim()}`);
  return result.stdout.split(" ")[0] || "empty";
}

/** Files a `git diff` names, from its own headers; nothing is inferred beyond them. */
function patchFiles(patch: Buffer): string[] {
  const files = new Set<string>();
  for (const line of patch.toString("latin1").split("\n")) {
    const match = /^diff --git a\/(.+?) b\/(.+)$/u.exec(line);
    if (match) files.add(match[2]!);
  }
  return [...files].slice(0, 2000);
}

function reviewSeat(agent: HerdrAgentSnapshot): ReviewSeat {
  return {
    seatId: agent.terminalId,
    occupantId: occupantIdForHerdrSession(agent.session!),
    harness: agent.agent,
    ...(agent.title ? { title: agent.title.slice(0, 200) } : {}),
  };
}

function paneOf(authority: PeerSeatAuthority): string {
  const proof = authority.proof;
  return proof.fleet === "default" ? proof.pane : `${proof.fleet}/${proof.pane}`;
}

const listItems = (items: readonly string[]) => items.map((item) => `- ${item}`).join("\n");

/**
 * The standing review gate (ADR 0287). Candidates and verdicts are durable
 * records bound to the exact patch the service stored and hashed. The
 * service routes both directions itself, so author and reviewer never need a
 * lead relay or a peer channel, and a verdict counts only for its own hash.
 */
export class ReviewGate {
  private readonly candidates = new Map<string, ReviewCandidate>();
  private readonly unreadable: boolean;
  private readonly patches: string;
  /** One decision at a time: candidate, verdict and waiver writes never interleave. */
  private queue: Promise<unknown> = Promise.resolve();

  private readonly options: ReviewGateOptions;

  constructor(options: ReviewGateOptions) {
    this.options = options;
    this.patches = join(dirname(options.path), "review-patches");
    let unreadable = false;
    try {
      const stored = z.array(ReviewCandidateSchema).parse(JSON.parse(readFileSync(options.path, "utf8")));
      for (const candidate of stored) this.candidates.set(candidate.id, candidate);
    } catch (error) {
      unreadable = (error as NodeJS.ErrnoException).code !== "ENOENT";
    }
    this.unreadable = unreadable;
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    // allow-swallowed-rejection -- The caller awaits `next` and sees its failure; the queue only orders work.
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** The exact native occupant at the proven pane, never a name or a caller's claim. */
  private async proven(authority: PeerSeatAuthority): Promise<HerdrAgentSnapshot | undefined> {
    const proof = authority.proof;
    if (proof.nativeSessionPending || !(await authority.validate())) return undefined;
    const agent = await this.options.seat(paneOf(authority));
    return agent?.session &&
      agent.paneId === paneOf(authority) &&
      occupantIdForHerdrSession(agent.session) === proof.nativeOccupantId
      ? agent
      : undefined;
  }

  list(projectId?: string): readonly ReviewCandidate[] {
    return [...this.candidates.values()]
      .filter((candidate) => projectId === undefined || candidate.projectId === projectId)
      .sort((left, right) => right.submittedAt.localeCompare(left.submittedAt));
  }

  get(id: string): ReviewCandidate | undefined {
    return this.candidates.get(id);
  }

  /** The stored patch bytes, as base64; the author and reviewer read exactly what was hashed. */
  patch(id: string): string | undefined {
    if (!this.candidates.has(id)) return undefined;
    try {
      return readFileSync(join(this.patches, `${id}.patch`)).toString("base64");
    } catch {
      return undefined;
    }
  }

  /** The author's or reviewer's own read of a candidate and its patch. */
  async read(
    authority: PeerSeatAuthority,
    id: string,
  ): Promise<{ candidate: ReviewCandidate; patch: string } | ReviewRefusal> {
    const seat = await this.proven(authority);
    if (!seat)
      return { error: "native_seat_required", detail: "Only a proven native seat reads candidates." };
    const candidate = this.candidates.get(id);
    const patch = this.patch(id);
    if (!candidate || patch === undefined)
      return { error: "unknown_candidate", detail: `No review candidate ${id}.` };
    const review = await this.options.review(candidate.projectId);
    const reviewers = review === undefined ? [] : await this.options.reviewers(candidate.projectId, review);
    const occupant = occupantIdForHerdrSession(seat.session!);
    if (
      candidate.author?.occupantId !== occupant &&
      candidate.reviewer?.occupantId !== occupant &&
      !reviewers.some((reviewer) => reviewer.terminalId === seat.terminalId)
    )
      return { error: "not_reviewer", detail: "Only the author and the project's reviewer read this patch." };
    return { candidate, patch };
  }

  /** A worker's landing candidate: stored, hashed by the service and sent to the reviewer. */
  submit(authority: PeerSeatAuthority, input: ReviewSubmission): Promise<ReviewCandidate | ReviewRefusal> {
    return this.serial(async () => {
      if (this.unreadable)
        return {
          error: "store_unavailable",
          detail: "The review store is unreadable; nothing was submitted.",
        };
      const author = await this.proven(authority);
      if (!author)
        return {
          error: "native_seat_required",
          detail: "Submit from your own native seat; nothing was stored.",
        };
      const bytes = Buffer.from(input.patch, "base64");
      if (!bytes.length || bytes.toString("base64") !== input.patch)
        return { error: "invalid_patch", detail: "The patch is not canonical base64 diff bytes." };
      let patchId: string;
      try {
        patchId = reviewPatchId(bytes);
      } catch (error) {
        return { error: "invalid_patch", detail: error instanceof Error ? error.message : String(error) };
      }
      if (patchId !== input.patchId)
        return {
          error: "patch_id_mismatch",
          detail: `The service hashed ${patchId}; the submission named ${input.patchId}. Nothing was stored.`,
        };
      const projectId = await this.options.seatProject(author);
      if (projectId === undefined)
        return { error: "no_project", detail: "Your checkout belongs to no project; nothing was stored." };
      const review = await this.options.review(projectId);
      if (review === undefined)
        return {
          error: "no_reviewer",
          detail: `Project ${projectId} names no reviewer, so its landings need no review. Nothing was stored.`,
        };
      const seat = reviewSeat(author);
      const existing = this.list(projectId).find(
        (candidate) =>
          candidate.patchId === patchId &&
          candidate.author?.occupantId === seat.occupantId &&
          candidate.status !== "superseded",
      );
      // The same exact patch from the same author is the same candidate; only its delivery is retried.
      if (existing) {
        if (existing.status === "awaiting_review" && existing.reviewer?.deliveryStage !== "delivered")
          return this.send(existing, review, author);
        return existing;
      }
      const earlier = this.list(projectId).filter(
        (candidate) =>
          (candidate.id === input.supersedes ||
            (candidate.author?.occupantId === seat.occupantId &&
              input.issue !== undefined &&
              candidate.issue === input.issue)) &&
          (candidate.status === "awaiting_review" || candidate.status === "changes"),
      );
      const id = randomUUID();
      const candidate: ReviewCandidate = {
        schemaVersion: 1,
        id,
        projectId,
        status: "awaiting_review",
        patchId,
        patchSha256: createHash("sha256").update(bytes).digest("hex"),
        bytes: bytes.length,
        files: patchFiles(bytes),
        base: input.base,
        head: input.head,
        ...(input.issue === undefined ? {} : { issue: input.issue }),
        summary: input.summary,
        evidence: [...input.evidence],
        author: seat,
        ...(earlier[0] === undefined ? {} : { supersedes: earlier[0].id }),
        submittedAt: new Date().toISOString(),
      };
      mkdirSync(this.patches, { recursive: true, mode: 0o700 });
      this.writeFile(join(this.patches, `${id}.patch`), bytes);
      const next = new Map(this.candidates);
      next.set(id, candidate);
      for (const prior of earlier) next.set(prior.id, { ...prior, status: "superseded", supersededBy: id });
      this.persist(next);
      return this.send(candidate, review, author);
    });
  }

  /** Sends the packet to the first live reviewer that is not the author, and records how far it got. */
  private async send(
    candidate: ReviewCandidate,
    review: ProjectReview,
    author: HerdrAgentSnapshot,
  ): Promise<ReviewCandidate> {
    const authorSeat = candidate.author!;
    const reviewer = (await this.options.reviewers(candidate.projectId, review)).find(
      (seat) =>
        seat.session !== undefined &&
        seat.terminalId !== authorSeat.seatId &&
        occupantIdForHerdrSession(seat.session) !== authorSeat.occupantId,
    );
    const lead = this.lead(author);
    if (!reviewer) {
      await this.options.notifyLead(
        lead,
        `Review candidate ${candidate.id} (${candidate.issue ?? "no issue"}, patch ${candidate.patchId}) from ${authorSeat.title ?? authorSeat.seatId} is waiting: project ${candidate.projectId} names a reviewer (${"seat" in review ? `seat ${review.seat}` : `role ${review.role}`}), but no live seat other than the author holds it. Hire or seat a reviewer; the author resubmits the same patch to deliver it.`,
      );
      return candidate;
    }
    const prior = candidate.supersedes === undefined ? undefined : this.candidates.get(candidate.supersedes);
    const text = [
      `Review request ${candidate.id} (ADR 0287). You are project ${candidate.projectId}'s standing reviewer: review adversarially and push back with concrete required changes; never approve what you have not read.`,
      `Author: ${authorSeat.title ?? authorSeat.seatId} (${authorSeat.seatId}, ${authorSeat.harness}).${candidate.issue === undefined ? "" : ` Issue: ${candidate.issue}.`}`,
      `Patch ${candidate.patchId}: ${candidate.files.length} files, ${candidate.bytes} bytes, ${candidate.base.slice(0, 12)}..${candidate.head.slice(0, 12)}.`,
      `Files:\n${listItems(candidate.files.slice(0, 50))}${candidate.files.length > 50 ? `\n- … ${candidate.files.length - 50} more` : ""}`,
      `Summary:\n${candidate.summary}`,
      ...(candidate.evidence.length ? [`Evidence:\n${listItems(candidate.evidence)}`] : []),
      ...(prior?.verdict
        ? [
            `This resubmits ${prior.id} (patch ${prior.patchId}), which got CHANGES. Check each one:\n${listItems(prior.verdict.findings)}`,
          ]
        : []),
      `Read the exact patch with review_candidate {"candidateId":"${candidate.id}"}. Record your verdict with review_verdict {"candidateId":"${candidate.id}","patchId":"${candidate.patchId}","verdict":"approve"|"changes","findings":[…]}; CHANGES lists each required change. Your verdict reaches the author and their lead. If the issue tracker is connected, also post your verdict on ${candidate.issue ?? "the issue"}.`,
    ].join("\n\n");
    let delivery: FleetSeatDelivery;
    try {
      delivery = await this.options.deliver(reviewer.terminalId, text, lead?.conversationId);
    } catch (error) {
      delivery = { outcome: "undelivered", detail: error instanceof Error ? error.message : String(error) };
    }
    const stage =
      delivery.deliveryStage ??
      (delivery.outcome === "delivered"
        ? "delivered"
        : delivery.outcome === "unconfirmed"
          ? "uncertain"
          : "unavailable");
    const updated: ReviewCandidate = {
      ...candidate,
      reviewer: {
        ...reviewSeat(reviewer),
        deliveryStage: stage,
        ...("detail" in delivery && delivery.detail ? { detail: delivery.detail.slice(0, 1000) } : {}),
        at: new Date().toISOString(),
      },
    };
    const next = new Map(this.candidates);
    next.set(updated.id, updated);
    this.persist(next);
    if (delivery.outcome === "delivered" || delivery.outcome === "unconfirmed")
      this.options.room?.({
        id: `review:${candidate.id}:candidate`,
        kind: "candidate",
        from: authorSeat,
        to: reviewSeat(reviewer),
        text: `Review candidate ${candidate.id}${candidate.issue === undefined ? "" : ` for ${candidate.issue}`}: patch ${candidate.patchId}, ${candidate.files.length} files.`,
      });
    else
      await this.options.notifyLead(
        lead,
        `Review candidate ${candidate.id} from ${authorSeat.title ?? authorSeat.seatId} did not reach reviewer ${reviewer.terminalId}: ${delivery.detail}. The author resubmits the same patch to retry delivery.`,
      );
    return updated;
  }

  /** The reviewer's verdict, bound to the candidate's stored hash. */
  verdict(authority: PeerSeatAuthority, input: ReviewVerdictInput): Promise<ReviewCandidate | ReviewRefusal> {
    return this.serial(async () => {
      if (this.unreadable)
        return {
          error: "store_unavailable",
          detail: "The review store is unreadable; nothing was recorded.",
        };
      const reviewer = await this.proven(authority);
      if (!reviewer)
        return { error: "native_seat_required", detail: "Record verdicts from your own native seat." };
      const candidate = this.candidates.get(input.candidateId);
      if (!candidate)
        return { error: "unknown_candidate", detail: `No review candidate ${input.candidateId}.` };
      if (candidate.status === "superseded")
        return {
          error: "superseded",
          detail: `Candidate ${candidate.id} was superseded by ${candidate.supersededBy ?? "a newer patch"}; review that one.`,
        };
      if (candidate.status !== "awaiting_review")
        return {
          error: "already_decided",
          detail: `Candidate ${candidate.id} is already ${candidate.status}.`,
        };
      if (input.patchId !== candidate.patchId)
        return {
          error: "patch_id_mismatch",
          detail: `Candidate ${candidate.id} is patch ${candidate.patchId}; your verdict named ${input.patchId}.`,
        };
      const seat = reviewSeat(reviewer);
      const review = await this.options.review(candidate.projectId);
      const eligible =
        review !== undefined &&
        (await this.options.reviewers(candidate.projectId, review)).some(
          (current) => current.terminalId === reviewer.terminalId,
        );
      if (
        !eligible ||
        seat.seatId === candidate.author?.seatId ||
        seat.occupantId === candidate.author?.occupantId
      )
        return {
          error: "not_reviewer",
          detail: `Only project ${candidate.projectId}'s reviewer, never the author, records this verdict.`,
        };
      const decided: ReviewCandidate = {
        ...candidate,
        status: input.verdict === "approve" ? "approved" : "changes",
        verdict: {
          verdict: input.verdict,
          findings: [...input.findings],
          ...(input.summary === undefined ? {} : { summary: input.summary }),
          reviewer: seat,
          sameHarness: candidate.author?.harness === seat.harness,
          at: new Date().toISOString(),
        },
      };
      const next = new Map(this.candidates);
      next.set(decided.id, decided);
      this.persist(next);
      const word = input.verdict === "approve" ? "APPROVE" : "CHANGES";
      const body = [
        `Review verdict for ${decided.id}${decided.issue === undefined ? "" : ` (${decided.issue})`}: ${word} from ${seat.title ?? seat.seatId} (${seat.harness}), bound to patch ${decided.patchId}.`,
        ...(input.summary === undefined ? [] : [input.summary]),
        ...(input.findings.length ? [`Findings:\n${listItems(input.findings)}`] : []),
      ].join("\n\n");
      const author =
        candidate.author === undefined ? undefined : await this.options.resolve(candidate.author.seatId);
      if (candidate.author) {
        const next =
          input.verdict === "approve"
            ? "Land this exact patch: run the landing gate (pnpm check:landing), which checks this approval by hash. Any further change to the patch needs a new review."
            : "Make each required change, commit, and call submit_for_review again with the same issue. The new patch gets a new review; this verdict never covers it.";
        try {
          await this.options.deliver(candidate.author.seatId, `${body}\n\n${next}`, undefined);
        } catch {
          // The verdict is durable on the candidate; the author's status read and the lead still see it.
        }
      }
      await this.options.notifyLead(
        author === undefined ? undefined : this.lead(author),
        `${body}\n\nNo action needed: the author has the verdict directly.${decided.verdict!.sameHarness ? " Note: author and reviewer run the same harness." : ""}`,
      );
      this.options.room?.({
        id: `review:${decided.id}:verdict`,
        kind: "verdict",
        from: seat,
        ...(candidate.author === undefined ? {} : { to: candidate.author }),
        text: body.slice(0, 2000),
      });
      return decided;
    });
  }

  /** A retired or replaced author falls back to the owner's default conversation. */
  private lead(agent: HerdrAgentSnapshot): ConversationOwner | undefined {
    try {
      return this.options.lead(agent);
    } catch {
      return undefined;
    }
  }

  /** What the landing gate asks for one exact patch from one checkout. */
  async landing(directory: string, patchId: string): Promise<ReviewLanding> {
    const projectId = await this.options.directoryProject(directory);
    const review = projectId === undefined ? undefined : await this.options.review(projectId);
    if (projectId === undefined || review === undefined || patchId === "empty")
      return {
        schemaVersion: 1,
        required: false,
        ...(projectId === undefined ? {} : { projectId }),
        patchId,
        status: "not_required",
        landable: true,
      };
    const matches = this.list(projectId).filter((candidate) => candidate.patchId === patchId);
    const candidate =
      matches.find((entry) => entry.status === "approved" || entry.status === "waived") ??
      matches.find((entry) => entry.status !== "superseded") ??
      matches[0];
    return {
      schemaVersion: 1,
      required: true,
      projectId,
      patchId,
      status: candidate?.status ?? "not_submitted",
      landable: candidate?.status === "approved" || candidate?.status === "waived",
      ...(candidate === undefined ? {} : { candidate }),
    };
  }

  /** An owner or lead lands one exact patch without review; who, why and the hash stay on the record. */
  waive(
    input: ReviewWaiverInput,
    waiver: Omit<ReviewWaiver, "at" | "reason">,
  ): Promise<ReviewCandidate | ReviewRefusal> {
    return this.serial(async () => {
      if (this.unreadable)
        return { error: "store_unavailable", detail: "The review store is unreadable; nothing was waived." };
      const bytes = Buffer.from(input.patch, "base64");
      let patchId: string;
      try {
        patchId = reviewPatchId(bytes);
      } catch (error) {
        return { error: "invalid_patch", detail: error instanceof Error ? error.message : String(error) };
      }
      if (patchId !== input.patchId)
        return {
          error: "patch_id_mismatch",
          detail: `The service hashed ${patchId}; the waiver named ${input.patchId}. Nothing was waived.`,
        };
      const projectId = await this.options.directoryProject(input.directory);
      if (projectId === undefined)
        return { error: "no_project", detail: "This checkout belongs to no project; nothing was waived." };
      if ((await this.options.review(projectId)) === undefined)
        return {
          error: "no_reviewer",
          detail: `Project ${projectId} names no reviewer; nothing needs waiving.`,
        };
      const recorded: ReviewWaiver = { ...waiver, reason: input.reason, at: new Date().toISOString() };
      const existing = this.list(projectId).find(
        (candidate) => candidate.patchId === patchId && candidate.status !== "superseded",
      );
      const id = existing?.id ?? randomUUID();
      const candidate: ReviewCandidate = existing
        ? { ...existing, status: "waived", waiver: recorded }
        : {
            schemaVersion: 1,
            id,
            projectId,
            status: "waived",
            patchId,
            patchSha256: createHash("sha256").update(bytes).digest("hex"),
            bytes: bytes.length,
            files: patchFiles(bytes),
            base: input.base,
            head: input.head,
            summary: `Waived without review: ${input.reason}`.slice(0, 4000),
            evidence: [],
            submittedAt: recorded.at,
            waiver: recorded,
          };
      if (!existing) {
        mkdirSync(this.patches, { recursive: true, mode: 0o700 });
        this.writeFile(join(this.patches, `${id}.patch`), bytes);
      }
      const next = new Map(this.candidates);
      next.set(id, candidate);
      this.persist(next);
      const text = `Review waived for patch ${patchId} (candidate ${id}, project ${projectId}) by the ${waiver.actor}: ${input.reason}`;
      if (waiver.actor === "lead")
        await this.options.notifyLead(
          waiver.conversationId === undefined ? undefined : { conversationId: waiver.conversationId },
          text,
        );
      this.options.room?.({
        id: `review:${id}:waiver`,
        kind: "waiver",
        from: {
          actor: waiver.actor,
          ...(waiver.conversationId === undefined ? {} : { conversationId: waiver.conversationId }),
        },
        ...(candidate.author === undefined ? {} : { to: candidate.author }),
        text,
      });
      return candidate;
    });
  }

  private writeFile(path: string, bytes: Buffer | string): void {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    const fd = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, path);
  }

  private persist(next: Map<string, ReviewCandidate>): void {
    const ordered = [...next.values()].sort((left, right) =>
      left.submittedAt.localeCompare(right.submittedAt),
    );
    const settled = ordered.filter((candidate) => candidate.status !== "awaiting_review");
    const pruned = new Set(
      settled.slice(0, Math.max(0, ordered.length - CANDIDATE_LIMIT)).map((candidate) => candidate.id),
    );
    const kept = ordered.filter((candidate) => !pruned.has(candidate.id));
    this.writeFile(this.options.path, `${JSON.stringify(kept)}\n`);
    this.candidates.clear();
    for (const candidate of kept) this.candidates.set(candidate.id, candidate);
    for (const id of pruned) {
      try {
        renameSync(join(this.patches, `${id}.patch`), join(this.patches, `${id}.patch.pruned`));
      } catch {
        // A pruned record's patch is no longer served either way.
      }
    }
  }
}
