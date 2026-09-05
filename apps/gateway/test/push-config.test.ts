import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createGatewayPush,
  GATEWAY_PUSH_CONFIG_FILE_ENV,
  loadGatewayPushConfig,
  type GatewayPushConfig,
} from "../src/push-config.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "clankie-gateway-push-"));
  tempDirs.push(root);
  return root;
}

/** A synthetic key of the right shape; no Apple credential is involved. */
function p256Pem(): string {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return privateKey.export({ format: "pem", type: "pkcs8" }).toString();
}

async function configured(
  overrides: Partial<GatewayPushConfig> = {},
  keyPem = p256Pem(),
): Promise<{ root: string; file: string; config: GatewayPushConfig }> {
  const root = await workspace();
  const privateKeyFile = join(root, "apns.p8");
  await writeFile(privateKeyFile, keyPem, { mode: 0o600 });
  const config: GatewayPushConfig = {
    teamId: "ABCDE12345",
    keyId: "FGHIJ67890",
    topic: "io.clankie.v2",
    privateKeyFile,
    databasePath: join(root, "state", "push.sqlite"),
    ...overrides,
  };
  const file = join(root, "push.json");
  await writeFile(file, JSON.stringify(config), { mode: 0o644 });
  return { root, file, config };
}

describe("gateway push configuration", () => {
  it("is absent by default, which is the ordinary no-push deployment", () => {
    expect(loadGatewayPushConfig({})).toBeUndefined();
    expect(loadGatewayPushConfig({ [GATEWAY_PUSH_CONFIG_FILE_ENV]: "   " })).toBeUndefined();
    expect(createGatewayPush(undefined)).toBeUndefined();
  });

  it("loads a complete configuration from the one file", async () => {
    const { file, config } = await configured();
    expect(loadGatewayPushConfig({ [GATEWAY_PUSH_CONFIG_FILE_ENV]: file })).toEqual(config);
  });

  it("builds both dependencies and closes what it opened", async () => {
    const { file } = await configured();
    const push = createGatewayPush(loadGatewayPushConfig({ [GATEWAY_PUSH_CONFIG_FILE_ENV]: file }));
    expect(push).toBeDefined();
    // The registry is live: a lookup against an empty database answers rather
    // than throwing, which also proves the file and its directory were created.
    expect(
      push?.registrations.delivery("mac_1", "device-1", {
        registrationId: "6f1f0f9a-4e7c-4a4f-9c1a-2b6d5f0a1c33",
        sequence: 1,
      }),
    ).toBe("not_registered");
    await push?.close();
  });

  it("fails clearly on a missing, unreadable, or malformed file — without echoing it", async () => {
    const root = await workspace();
    const missing = join(root, "nope.json");
    expect(() => loadGatewayPushConfig({ [GATEWAY_PUSH_CONFIG_FILE_ENV]: missing })).toThrow(
      /could not be read/u,
    );

    const secretish = join(root, "push.json");
    await writeFile(secretish, "{ this is not json, and it holds sk_live_supersecret }");
    try {
      loadGatewayPushConfig({ [GATEWAY_PUSH_CONFIG_FILE_ENV]: secretish });
      throw new Error("expected a rejection");
    } catch (error) {
      expect((error as Error).message).toMatch(/not valid JSON/u);
      expect((error as Error).message).not.toContain("supersecret");
    }
  });

  it("names the offending field without printing its value", async () => {
    const { file } = await configured({ teamId: "not-a-team-id" as GatewayPushConfig["teamId"] });
    try {
      loadGatewayPushConfig({ [GATEWAY_PUSH_CONFIG_FILE_ENV]: file });
      throw new Error("expected a rejection");
    } catch (error) {
      expect((error as Error).message).toContain("teamId");
      expect((error as Error).message).not.toContain("not-a-team-id");
    }
  });

  it("refuses a relative path, an unknown field, and an in-memory database", async () => {
    const relative = await configured({ databasePath: "state/push.sqlite" });
    expect(() => loadGatewayPushConfig({ [GATEWAY_PUSH_CONFIG_FILE_ENV]: relative.file })).toThrow(
      /databasePath: must be an absolute path/u,
    );

    const inMemory = await configured({ databasePath: ":memory:" });
    expect(() => loadGatewayPushConfig({ [GATEWAY_PUSH_CONFIG_FILE_ENV]: inMemory.file })).toThrow(
      /databasePath/u,
    );

    const root = await workspace();
    const extra = join(root, "push.json");
    const { config } = await configured();
    await writeFile(extra, JSON.stringify({ ...config, deviceToken: "aabbcc" }));
    // Device material has no place in operator configuration; a stray field is
    // a refusal rather than something quietly ignored.
    expect(() => loadGatewayPushConfig({ [GATEWAY_PUSH_CONFIG_FILE_ENV]: extra })).toThrow(
      /deviceToken|unrecognized/iu,
    );
  });

  it("refuses a signing key that is missing or of the wrong algorithm", async () => {
    const root = await workspace();
    const { file: withMissingKey } = await configured({ privateKeyFile: join(root, "absent.p8") });
    expect(() =>
      createGatewayPush(loadGatewayPushConfig({ [GATEWAY_PUSH_CONFIG_FILE_ENV]: withMissingKey })),
    ).toThrow(/signing key .* could not be read/u);

    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const { file: rsaConfigured } = await configured(
      {},
      rsa.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    );
    expect(() =>
      createGatewayPush(loadGatewayPushConfig({ [GATEWAY_PUSH_CONFIG_FILE_ENV]: rsaConfigured })),
    ).toThrow(/P-256/u);
  });
});
