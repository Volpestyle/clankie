import { renameSync, rmSync, writeFileSync, lstatSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  LOCAL_COMPANION_HANDOFF_FILE,
  LOCAL_COMPANION_OFFER_PATH,
  LocalCompanionHandoffSchema,
  LocalCompanionOfferSchema,
  LocalCompanionIssuerSchema,
  LOCAL_COMPANION_ISSUER_FILE,
} from "@clankie/protocol/local-companion";
import { prepareCompanionDirectory } from "./local-companion-files.ts";
import { readPrivateJson } from "./update-files.ts";
import { type OperatorRequestOptions } from "./operator-request.ts";
import { PairingOfferError } from "./pairing-offer.ts";

/** The installer calls this as the owner. The app reads/removes the file as that same UID. */
export async function writeLocalCompanionHandoff(
  options: OperatorRequestOptions & {
    env: NodeJS.ProcessEnv;
  },
): Promise<string> {
  const origin = new URL(options.controlPlaneUrl);
  if (origin.hostname === "localhost") origin.hostname = "127.0.0.1";
  // Validate before sending the owner's bearer to any destination.
  LocalCompanionHandoffSchema.shape.controlPlaneUrl.parse(origin.href);
  const root = resolve(options.env.CLANKIE_STATE?.trim() || join(homedir(), ".clankie"));
  const directory = prepareCompanionDirectory(root);
  const issuer = LocalCompanionIssuerSchema.parse(
    readPrivateJson(join(directory, LOCAL_COMPANION_ISSUER_FILE)),
  );
  if (issuer.controlPlaneUrl !== origin.origin || dirname(issuer.socketPath) !== directory)
    throw new PairingOfferError("unavailable");
  const socket = lstatSync(issuer.socketPath);
  if (!socket.isSocket() || !process.getuid || socket.uid !== process.getuid())
    throw new PairingOfferError("unavailable");
  const token = options.operatorToken?.trim();
  if (!token) throw new PairingOfferError("unauthorized");
  const payload = await new Promise<unknown>((resolve, reject) => {
    const request = httpRequest(
      {
        socketPath: issuer.socketPath,
        path: LOCAL_COMPANION_OFFER_PATH,
        method: "POST",
        signal: options.signal,
        timeout: 30_000,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
          if (body.length > 4096) {
            response.destroy();
            reject(new PairingOfferError("malformed"));
          }
        });
        response.on("error", () => reject(new PairingOfferError("unavailable")));
        response.on("end", () => {
          if (response.statusCode !== 200) {
            reject(new PairingOfferError(response.statusCode === 401 ? "unauthorized" : "unavailable"));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch {
            reject(new PairingOfferError("malformed"));
          }
        });
      },
    );
    request.on("timeout", () => request.destroy());
    request.on("error", () =>
      reject(new PairingOfferError(options.signal?.aborted ? "interrupted" : "unavailable")),
    );
    request.end("{}");
  });
  const offer = LocalCompanionOfferSchema.parse(payload);
  if (Date.parse(offer.expiresAt) <= Date.now()) throw new PairingOfferError("expired");
  const handoff = LocalCompanionHandoffSchema.parse({ ...offer, controlPlaneUrl: origin.origin });
  if (prepareCompanionDirectory(root) !== directory) throw new PairingOfferError("unavailable");
  const path = join(directory, LOCAL_COMPANION_HANDOFF_FILE);
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, JSON.stringify(handoff) + "\n", { flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
  return path;
}
