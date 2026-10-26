import { spawn } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export async function startEvidenceMinio(root: string, binary: string) {
  const dir = join(root, "minio");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const reservation = createServer();
  await new Promise<void>((r) => reservation.listen(0, "127.0.0.1", r));
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((r) => reservation.close(() => r()));
  const accessKeyId = randomBytes(16).toString("hex"),
    secretAccessKey = randomBytes(32).toString("hex");
  const endpoint = `http://127.0.0.1:${port}`;
  const child = spawn(
    binary,
    ["server", "--address", `127.0.0.1:${port}`, "--console-address", "127.0.0.1:0", dir],
    {
      env: {
        ...process.env,
        MINIO_BROWSER: "off",
        MINIO_UPDATE: "off",
        MINIO_ROOT_USER: accessKeyId,
        MINIO_ROOT_PASSWORD: secretAccessKey,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let logs = "";
  child.stdout.on("data", (data) => {
    logs += String(data);
  });
  child.stderr.on("data", (data) => {
    logs += String(data);
  });
  const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
  let stopping:
    | Promise<{ code: number | null; portClosed: boolean; removed: boolean; logs: string }>
    | undefined;
  const stop = () =>
    (stopping ??= (async () => {
      child.kill("SIGTERM");
      const code = await exited;
      await rm(dir, { recursive: true, force: true });
      return {
        code,
        portClosed: await fetch(endpoint + "/minio/health/live").then(
          () => false,
          () => true,
        ),
        removed: true,
        logs,
      };
    })());
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null) throw new Error("minio_fixture_exited");
      if (
        await fetch(endpoint + "/minio/health/live").then(
          (r) => r.ok,
          () => false,
        )
      )
        break;
      if (attempt === 99) throw new Error("minio_fixture_start_timeout");
      await delay(100);
    }
  } catch (error) {
    await stop();
    throw error;
  }
  const credentials = { accessKeyId, secretAccessKey };
  // Real local MinIO session exchange, signed without consulting an SDK chain.
  // This is not an AWS STS/IAM proof and does not install a production issuer adapter.
  const issueSession = async () => {
    const body = "Action=AssumeRole&Version=2011-06-15&DurationSeconds=900";
    const date = new Date().toISOString().replace(/[:-]|\.\d{3}/gu, "");
    const day = date.slice(0, 8),
      scope = `${day}/us-east-1/sts/aws4_request`;
    const hash = (text: string) => createHash("sha256").update(text).digest("hex");
    const hmac = (key: Buffer | string, data: string): Buffer =>
      createHmac("sha256", key).update(data).digest();
    const headers = `content-type:application/x-www-form-urlencoded\nhost:127.0.0.1:${port}\nx-amz-date:${date}\n`;
    const names = "content-type;host;x-amz-date";
    const canonical = ["POST", "/", "", headers, names, hash(body)].join("\n");
    const key = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, day), "us-east-1"), "sts"), "aws4_request");
    const signature = hmac(key, ["AWS4-HMAC-SHA256", date, scope, hash(canonical)].join("\n")).toString(
      "hex",
    );
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-amz-date": date,
        authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${names}, Signature=${signature}`,
      },
      body,
    });
    if (!response.ok) throw new Error("local_minio_session_refused");
    const xml = await response.text();
    const field = (name: string) => {
      const value = xml.match(new RegExp(`<${name}>([^<]+)</${name}>`))?.[1];
      if (!value) throw new Error("local_minio_session_malformed");
      return value;
    };
    return {
      accessKeyId: field("AccessKeyId"),
      secretAccessKey: field("SecretAccessKey"),
      sessionToken: field("SessionToken"),
    };
  };
  return { endpoint, credentials, issueSession, stop };
}
