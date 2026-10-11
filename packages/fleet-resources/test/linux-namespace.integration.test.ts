import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { resourcePython } from "../src/process.ts";

const execute = promisify(execFile);
const proof = join(import.meta.dirname, "fixtures/linux-namespace-proof.py");

it.skipIf(process.platform === "win32")(
  "the containment journal refuses uncertain cleanup and preserves exclusive durable claims",
  async () => {
    const result = await execute(resourcePython, ["-I", "-B", proof], {
      timeout: 10_000,
    });
    expect(result.stderr).toContain("Ran 3 tests");
    expect(result.stderr).toContain("OK");
  },
);

// Real namespace creation is an explicitly admitted Linux proof. Docker is not
// required by ordinary landing gates; those still run the portable contracts.
it.skipIf(process.env.CLANKIE_LINUX_NAMESPACE_PROOF !== "1")(
  "a real Linux namespace contains detached descendants through cancellation and crashes",
  async () => {
    const result = await execute(resourcePython, ["-I", "-B", proof, "--integration"], {
      timeout: 30_000,
    });
    expect(result.stderr).toContain("Ran 8 tests");
    expect(result.stderr).toContain("OK");
  },
);
