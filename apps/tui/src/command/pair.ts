import { resolveOperatorCredential, type CredentialStore } from "@clankie/credential-broker";
import QRCode from "qrcode";
import {
  pairingFailureMessage,
  PairingOfferError,
  requestPairingOffer,
  type PairingOffer,
  type PairingOfferStatus,
} from "../../bin/pairing-offer.ts";
import { commandHost, outputJson, type Writable } from "./io.ts";

const DEFAULT_PAIR_TIMEOUT_MS = 10_000;
const DEFAULT_REVIEW_COUNT = 3;
const REVIEW_COUNT_MAX = 10;
const REVIEW_DAYS_MAX = 31;
const PAIR_USAGE = "Usage: clankie pair [--json] [--timeout SEC] [--review --days N [--count N]]";

export interface PairCommandOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly host?: string;
  readonly fetchImpl?: typeof fetch;
  readonly operatorCredentialStore?: CredentialStore;
  readonly stdout?: Writable;
  readonly stderr?: Writable;
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
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const offers: PairingOffer[] = [];
  try {
    // Review mode mints a small set of independent single-use offers, so a
    // second reviewer attempt takes the next code instead of failing `consumed`.
    for (let index = 0; index < (review?.count ?? 1); index += 1) {
      offers.push(
        await requestPairingOffer({
          controlPlaneUrl,
          operatorToken: operatorCredential?.token,
          ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
          signal: controller.signal,
          ...(review === undefined ? {} : { review: { days: review.days } }),
        }),
      );
    }
  } catch (error) {
    const status: PairingOfferStatus = error instanceof PairingOfferError ? error.status : "unavailable";
    const message = error instanceof PairingOfferError ? error.message : pairingFailureMessage("unavailable");
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
        offers: offers.map((offer) => ({
          code: offer.code,
          deepLink: offer.deepLink,
          expiresAt: offer.expiresAt,
        })),
      });
      return 0;
    }
    const lines = [
      `REVIEW OFFER — ${review.days} day${review.days === 1 ? "" : "s"}, ${offers.length} single-use code${offers.length === 1 ? "" : "s"}.`,
      "Hand these to App Review or a tester; each pairs one device. Revoke the",
      "resulting devices with `clankie devices` after the review.",
      "",
    ];
    for (const [index, offer] of offers.entries()) {
      lines.push(
        await QRCode.toString(offer.deepLink, { type: "terminal", small: true }),
        `Code ${index + 1}: ${offer.code}`,
        offer.deepLink,
        `Expires ${offer.expiresAt}`,
        "",
      );
    }
    stdout.write(lines.join("\n"));
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
