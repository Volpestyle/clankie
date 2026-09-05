import { resolveOperatorCredential } from "@clankie/credential-broker";
import QRCode from "qrcode";
import {
  pairingFailureMessage,
  PairingOfferError,
  requestPairingOffer,
  type PairingOffer,
  type PairingOfferStatus,
} from "../../bin/pairing-offer.ts";
import { createServiceOptions, startOne, type CreateServiceOptionsInput } from "../../bin/services.ts";
import { commandHost, outputJson, type Writable } from "./io.ts";

/** One deadline for the whole command: starting the relay counts against it. */
const DEFAULT_PAIR_TIMEOUT_MS = 30_000;
const DEFAULT_REVIEW_COUNT = 3;
const REVIEW_COUNT_MAX = 10;
const REVIEW_DAYS_MAX = 31;
const PAIR_USAGE = "Usage: clankie pair [--json] [--timeout SEC] [--review --days N [--count N]]";

/** The loopback stack is the only one this launcher can start or speak for. */
function isLocalControlPlane(controlPlaneUrl: string): boolean {
  try {
    const { hostname } = new URL(controlPlaneUrl);
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

/** Host and port only: a control-plane URL may carry userinfo. */
function safeHost(controlPlaneUrl: string): string {
  try {
    return new URL(controlPlaneUrl).host;
  } catch {
    return "that host";
  }
}

/**
 * The relay is the only thing a paired device ever talks to, and it was the one
 * service nobody started: during the first phone dogfood an offer minted
 * against a healthy control plane pointed the phone at a port with nothing
 * listening (VUH-1037). Pairing therefore guarantees the device path first — a
 * healthy relay is reused, a stopped one is started, and every failure aborts
 * before a single offer is minted.
 *
 * The guarantee only exists for a local control plane. A remote one runs its
 * own relay, no authenticated route reports that relay's readiness, and
 * starting one here would prove nothing — so pairing fails closed and says
 * where to run it rather than minting an offer it cannot stand behind.
 *
 * Failures are reported with static, actionable text: the supervisor's own
 * message can carry a spawn error, and this boundary stays secret-free.
 */
async function ensureRelayForPairing(
  options: PairCommandOptions,
  input: { readonly controlPlaneUrl: string; readonly timeoutMs: number },
): Promise<void> {
  if (!isLocalControlPlane(input.controlPlaneUrl)) {
    throw new PairingOfferError(
      "unavailable",
      `Pairing cannot prove the relay on ${safeHost(input.controlPlaneUrl)} is running, and an offer that points at a stopped relay pairs nothing. Run \`clankie pair\` on that machine, where its launcher owns the relay.`,
    );
  }
  try {
    await startOne("relay", { ...(await createServiceOptions(options)), timeoutMs: input.timeoutMs });
  } catch {
    throw new PairingOfferError(
      "unavailable",
      "App relay is not running and could not be started, so no offer was minted — a paired device would have nothing to reach. Run `clankie restart relay`, then retry.",
    );
  }
}

/** QR + code + link per offer; the one place secret display data is rendered. */
async function offerBlocks(offers: readonly PairingOffer[]): Promise<string[]> {
  const lines: string[] = [];
  for (const [index, offer] of offers.entries()) {
    lines.push(
      await QRCode.toString(offer.deepLink, { type: "terminal", small: true }),
      `Code ${index + 1}: ${offer.code}`,
      offer.deepLink,
      `Expires ${offer.expiresAt}`,
      "",
    );
  }
  return lines;
}

/** The offer fields an agent reads back; never the raw wire record. */
function offerJson(offers: readonly PairingOffer[]): unknown[] {
  return offers.map((offer) => ({
    code: offer.code,
    deepLink: offer.deepLink,
    expiresAt: offer.expiresAt,
  }));
}

export interface PairCommandOptions extends CreateServiceOptionsInput {
  readonly host?: string;
  readonly stdout?: Writable;
}

interface PairCliOptions {
  readonly json: boolean;
  readonly timeoutMs: number;
  /** Review mode: `count` independent single-use offers that each live `days`. */
  readonly review?: { readonly days: number; readonly count: number };
}

function parsePairArgs(args: readonly string[]): PairCliOptions {
  let json = false;
  let timeoutMs = DEFAULT_PAIR_TIMEOUT_MS;
  let review = false;
  let days: number | undefined;
  let count: number | undefined;
  const integerArg = (index: number, name: string, max: number): number => {
    const value = args[index + 1];
    if (value === undefined) throw new Error(PAIR_USAGE);
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
      throw new Error(`${name} must be a whole number from 1 to ${max}.`);
    }
    return parsed;
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--timeout") {
      const value = args[index + 1];
      if (value === undefined) throw new Error(PAIR_USAGE);
      const seconds = Number(value);
      if (!Number.isFinite(seconds) || seconds <= 0) throw new Error("Timeout must be a positive number.");
      timeoutMs = seconds * 1_000;
      index += 1;
      continue;
    }
    if (arg === "--review") {
      review = true;
      continue;
    }
    if (arg === "--days") {
      days = integerArg(index, "--days", REVIEW_DAYS_MAX);
      index += 1;
      continue;
    }
    if (arg === "--count") {
      count = integerArg(index, "--count", REVIEW_COUNT_MAX);
      index += 1;
      continue;
    }
    throw new Error(PAIR_USAGE);
  }
  if (!review) {
    if (days !== undefined || count !== undefined) throw new Error("--days and --count require --review.");
    return { json, timeoutMs };
  }
  if (days === undefined) throw new Error("--review requires --days N.");
  return { json, timeoutMs, review: { days, count: count ?? DEFAULT_REVIEW_COUNT } };
}

export async function runPairCommand(args: readonly string[], options: PairCommandOptions): Promise<number> {
  const { json, timeoutMs, review } = parsePairArgs(args);
  const env = options.env ?? process.env;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const controlPlaneUrl = commandHost({ ...options, env });
  const operatorCredential = await resolveOperatorCredential({
    env,
    ...(options.operatorCredentialStore === undefined ? {} : { store: options.operatorCredentialStore }),
  });

  const controller = new AbortController();
  const deadline = Date.now() + timeoutMs;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const offers: PairingOffer[] = [];
  try {
    // Authenticate before any side effect: an unauthenticated caller must not
    // be able to start a service, so this precedes the relay guarantee.
    const operatorToken = operatorCredential?.token?.trim();
    if (operatorToken === undefined || operatorToken.length === 0) {
      throw new PairingOfferError("unauthorized");
    }
    await ensureRelayForPairing(
      { ...options, env },
      { controlPlaneUrl, timeoutMs: Math.max(1, deadline - Date.now()) },
    );
    // Review mode mints a small set of independent single-use offers, so a
    // second reviewer attempt takes the next code instead of failing `consumed`.
    for (let index = 0; index < (review?.count ?? 1); index += 1) {
      // Per mint, not once per batch: the supervisor's deadline is approximate
      // (its probe carries its own timeout) and each POST costs a round trip,
      // so the command's own clock decides whether the *next* one may begin. A
      // fetch double that ignores the signal must not slip through either.
      if (controller.signal.aborted) throw new PairingOfferError("interrupted");
      offers.push(
        await requestPairingOffer({
          controlPlaneUrl,
          operatorToken,
          ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
          signal: controller.signal,
          ...(review === undefined ? {} : { review: { days: review.days } }),
        }),
      );
    }
  } catch (error) {
    const status: PairingOfferStatus = error instanceof PairingOfferError ? error.status : "unavailable";
    const message = error instanceof PairingOfferError ? error.message : pairingFailureMessage("unavailable");
    // Whatever the batch already minted is live single-use capability on the
    // service, and an unredeemed offer has no revoke route — it can only be
    // used or left to expire. Discarding it would leave pairing capability
    // standing that the operator never saw and cannot cancel, so a partial run
    // reports the codes it made and still exits 1.
    if (offers.length > 0) {
      if (json) {
        outputJson(stdout, {
          ok: false,
          status,
          error: message,
          partial: true,
          ...(review === undefined ? {} : { review: true }),
          offers: offerJson(offers),
        });
      } else {
        stdout.write(
          [
            `PARTIAL — ${offers.length} offer${offers.length === 1 ? "" : "s"} had already been minted when pairing failed.`,
            "They are live, single-use, and cannot be revoked before they expire:",
            "hand them out or let them lapse.",
            "",
            ...(await offerBlocks(offers)),
          ].join("\n"),
        );
      }
      stderr.write(`clankie: ${message}\n`);
      return 1;
    }
    if (json) outputJson(stdout, { ok: false, status, error: message });
    else stderr.write(`clankie: ${message}\n`);
    return 1;
  } finally {
    clearTimeout(timer);
  }

  if (review !== undefined) {
    if (json) {
      outputJson(stdout, {
        ok: true,
        review: true,
        expiresAt: offers[0]?.expiresAt,
        offers: offerJson(offers),
      });
      return 0;
    }
    stdout.write(
      [
        `REVIEW OFFER — ${review.days} day${review.days === 1 ? "" : "s"}, ${offers.length} single-use code${offers.length === 1 ? "" : "s"}.`,
        "Hand these to App Review or a tester; each pairs one device. Revoke the",
        "resulting devices with `clankie devices` after the review.",
        "",
        ...(await offerBlocks(offers)),
      ].join("\n"),
    );
    return 0;
  }

  const offer = offers[0];
  if (offer === undefined) throw new Error("No pairing offer was minted.");
  if (json) {
    outputJson(stdout, { ok: true, code: offer.code, deepLink: offer.deepLink, expiresAt: offer.expiresAt });
    return 0;
  }

  const qr = await QRCode.toString(offer.deepLink, { type: "terminal", small: true });
  stdout.write(
    [
      "Scan this QR with the Clankie app to pair this device:",
      "",
      qr,
      `Pairing code: ${offer.code}`,
      "Or open this link on the device:",
      offer.deepLink,
      `Expires ${offer.expiresAt} · single use — run \`clankie pair\` again for a new offer.`,
      "",
    ].join("\n"),
  );
  return 0;
}
