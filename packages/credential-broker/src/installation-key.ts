import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { createDefaultCredentialStore, type CredentialStore } from "./credential-store.ts";

export interface InstallationKey {
  readonly publicKey: string;
  sign(payload: string): string;
}

/** One key per installation, minted under the broker's cross-process mutation lock. */
export async function ensureInstallationKey(
  installationId: string,
  store: CredentialStore = createDefaultCredentialStore(),
): Promise<InstallationKey> {
  if (!/^[A-Za-z0-9_-]{22}$/u.test(installationId)) throw new Error("Invalid installation id");
  const id = `gateway-installation-key:${installationId}`;
  if (store.updateMany === undefined) throw new Error("Installation keys require atomic credential storage");
  const group = await store.updateMany([id], async (current) => {
    if (current[id] !== undefined) return current;
    const { privateKey } = generateKeyPairSync("ed25519");
    // wellknown entries have no secret prefix in broker diagnostics.
    return {
      [id]: {
        type: "wellknown",
        key: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
        token: "ed25519",
      },
    };
  });
  const stored = group[id];
  if (stored?.type !== "wellknown" || stored.token !== "ed25519")
    throw new Error("Invalid stored installation key");
  const privateKey = createPrivateKey({
    key: Buffer.from(stored.key, "base64"),
    type: "pkcs8",
    format: "der",
  });
  if (privateKey.asymmetricKeyType !== "ed25519")
    throw new Error("Invalid stored installation key algorithm");
  return {
    publicKey: createPublicKey(privateKey).export({ type: "spki", format: "der" }).toString("base64url"),
    sign: (payload) => sign(null, Buffer.from(payload), privateKey).toString("base64url"),
  };
}
