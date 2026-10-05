import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { HostedBodyResourceError, type HostedBodyClient } from "./hosted-body.ts";

const IdentitySchema = z
  .object({
    version: z.literal(1),
    keyId: z.string().regex(/^[A-Za-z0-9_-]{22}$/u),
    key: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  })
  .strict();
type Identity = z.infer<typeof IdentitySchema>;

/** Public body half of the fleet's security-state contract. No customer keys leave this machine. */
export class HostedDeviceSecurity {
  private generation = -1;
  private readonly client: Pick<HostedBodyClient, "readSecurityState" | "declareAuthKey" | "revokeDevice"> &
    Partial<Pick<HostedBodyClient, "declareSupportDevice">>;
  private readonly identityPath: string;
  constructor(client: HostedDeviceSecurity["client"], identityPath: string) {
    this.client = client;
    this.identityPath = identityPath;
  }

  private async read() {
    const state = await this.client.readSecurityState();
    if (state.gen < this.generation) throw new Error("Hosted security state regressed");
    this.generation = state.gen;
    return state;
  }

  async prepare(
    localKey: Uint8Array | undefined,
    locallyRevoked: readonly string[],
  ): Promise<{
    key: Uint8Array<ArrayBuffer>;
    keyId?: string;
    revocations: { dev: string; at: number; gen: number }[];
  }> {
    let state = await this.read(); // No disk identity mutation before a verified, nonce-bound read.
    const remote = new Set(state.rev.map((entry) => entry.dev));
    for (const deviceId of locallyRevoked) {
      if (!remote.has(deviceId)) await this.client.revokeDevice(deviceId);
    }
    if (locallyRevoked.some((id) => !remote.has(id))) state = await this.read();
    if (locallyRevoked.some((id) => !state.rev.some((entry) => entry.dev === id)))
      throw new Error("Hosted device revocation not durable");

    let identity = await this.load();
    for (let attempt = 0; attempt < 3; attempt++) {
      if (identity === undefined || (state.ak !== null && state.ak.kid !== identity.keyId)) {
        // On first enrollment only, preserve existing valid sessions. A missing
        // id after enrollment, or a stale id, must get NEW bytes, never a new id
        // wrapped around an old key from the restored disk.
        const key =
          state.ak === null && identity === undefined && localKey?.byteLength === 32
            ? Buffer.from(localKey)
            : randomBytes(32);
        identity = {
          version: 1,
          keyId: randomBytes(16).toString("base64url"),
          key: key.toString("base64url"),
        };
        await this.save(identity);
      }
      if (state.ak?.kid !== identity.keyId) {
        try {
          await this.client.declareAuthKey(identity.keyId, state.ak?.kid);
        } catch (error) {
          if (
            !(error instanceof HostedBodyResourceError) ||
            (error.code !== "stale_auth_key" && error.code !== "key_retired")
          )
            throw error;
          state = await this.read();
          continue;
        }
      }
      // Confirm durable authority before exposing a signer. A lost declaration
      // response is recoverable next boot because the same key/id is on disk.
      state = await this.read();
      if (state.ak?.kid !== identity.keyId) continue;
      return {
        key: Uint8Array.from(Buffer.from(identity.key, "base64url")),
        keyId: identity.keyId,
        revocations: state.rev,
      };
    }
    throw new Error("Hosted authentication key changed during recovery");
  }

  async revokeDevice(deviceId: string): Promise<void> {
    await this.client.revokeDevice(deviceId);
  }

  async publishSupportDevice(deviceId: string, supportGrantId: string): Promise<void> {
    const existing = (await this.read()).sp?.find((entry) => entry.dev === deviceId);
    if (existing !== undefined) {
      if (existing.grant !== supportGrantId) throw new Error("Hosted support device purpose conflicts");
      return;
    }
    if (this.client.declareSupportDevice === undefined)
      throw new Error("Hosted support device publication unavailable");
    await this.client.declareSupportDevice(deviceId, supportGrantId);
    const confirmed = (await this.read()).sp?.find((entry) => entry.dev === deviceId);
    if (confirmed?.grant !== supportGrantId) throw new Error("Hosted support device publication unconfirmed");
  }

  private async load(): Promise<Identity | undefined> {
    let file;
    try {
      file = await open(this.identityPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await file.stat();
      if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.size > 1024)
        throw new Error("Invalid hosted authentication identity file");
      return IdentitySchema.parse(JSON.parse(await file.readFile("utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Error("Hosted authentication identity unavailable");
    } finally {
      await file?.close();
    }
  }

  private async save(identity: Identity): Promise<void> {
    await mkdir(dirname(this.identityPath), { recursive: true });
    const temporary = `${this.identityPath}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify(identity));
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, this.identityPath);
      const directory = await open(dirname(this.identityPath), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }
}
