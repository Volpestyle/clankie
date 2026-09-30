import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error -- checkout eval tooling is plain ESM.
import { cases } from "../../../scripts/evals/cases.mjs";
// @ts-expect-error -- checkout eval tooling is plain ESM.
import { judge, parseEvents, plan, prepare } from "../../../scripts/evals/run.mjs";
// @ts-expect-error -- checkout eval tooling is plain ESM.
import { cleanEnv, executeSandbox, installAuth, removeAuth } from "../../../scripts/evals/isolation.mjs";

const roots: string[] = [];
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "eval-test-")));
  roots.push(root);
  installAuth(root, "codex", '{"test":true}');
  mkdirSync(join(root, "worktree"));
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("requires an explicit larger call budget for a matrix and rejects typos", () => {
  expect(plan([]).matrix).toHaveLength(3);
  expect(() => plan(["--cases", "all"])).toThrow("raise --max-runs");
  expect(plan(["--cases", "memory-card", "--configs", "current,plain,trimmed"]).matrix).toHaveLength(3);
  expect(() => plan(["--configs", "typo"])).toThrow("Unknown configuration");
  expect(() => plan(["--max-runs", "NaN"])).toThrow();
  expect(() => plan(["--rework", "3"])).toThrow();
});

it("accounts for each provider's cached token semantics and missing usage", () => {
  expect(
    parseEvents(
      "codex",
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 100, cached_input_tokens: 70, output_tokens: 8 },
      }),
    ).tokens.total,
  ).toBe(108);
  expect(
    parseEvents(
      "claude",
      JSON.stringify({
        type: "result",
        usage: {
          input_tokens: 10,
          cache_read_input_tokens: 70,
          cache_creation_input_tokens: 20,
          output_tokens: 8,
        },
      }),
    ).tokens.total,
  ).toBe(108);
  expect(parseEvents("codex", "bad json\n").tokens).toBeNull();
  expect(
    parseEvents(
      "claude",
      JSON.stringify({
        type: "result",
        usage: { input_tokens: 100 },
        modelUsage: {
          main: { inputTokens: 100, outputTokens: 4 },
          helper: { inputTokens: 20, outputTokens: 2 },
        },
      }),
    ).tokens.total,
  ).toBe(126);
  expect(
    parseEvents("claude", '{"type":"result","subtype":"error_max_turns","is_error":true}').providerError,
  ).toBe("error_max_turns");
});

it("never inherits provider keys, live sockets or owner state", () => {
  const env = cleanEnv("/fixture");
  expect(env.HOME).toBe("/fixture/home");
  expect(Object.keys(env)).not.toContain("ANTHROPIC_API_KEY");
  expect(Object.keys(env)).not.toContain("OPENAI_API_KEY");
  expect(Object.keys(env)).not.toContain("CLANKIE_OPERATOR_TOKEN");
});

describe.skipIf(process.platform !== "darwin")("OS isolation", () => {
  it("permits fixture edits and denies outside reads, writes, signals and loopback", async () => {
    const root = fixture();
    const other = fixture();
    const marker = join(other, "private.txt");
    writeFileSync(marker, "private");
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw Error("No port");
    try {
      const script = `const fs=require('fs'),net=require('net');
        fs.writeFileSync('own.txt','ok');
        for(const f of [()=>fs.readFileSync(${JSON.stringify(marker)}),()=>fs.writeFileSync(${JSON.stringify(marker)},'bad'),()=>process.kill(${process.pid},0),()=>fs.writeFileSync('../events.jsonl','spoof'),()=>fs.rmdirSync(process.cwd())]) {
          let denied=false;try{f()}catch{denied=true}if(!denied)process.exit(2);
        }
        const socket=net.connect(${address.port},'127.0.0.1'); socket.on('connect',()=>process.exit(3)); socket.on('error',()=>process.exit(0)); setTimeout(()=>process.exit(4),1500);`;
      const result = await executeSandbox({ root, binary: process.execPath, args: ["-e", script] });
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
      expect(readFileSync(marker, "utf8")).toBe("private");
      expect(readFileSync(join(root, "worktree", "own.txt"), "utf8")).toBe("ok");
    } finally {
      server.close();
    }
  });

  it("runs checks without network, rejects broken code and accepts the requested fix", async () => {
    const root = fixture();
    const test = cases.find((c: { id: string }) => c.id === "memory-card");
    writeFileSync(join(root, "worktree", "solution.mjs"), test.files["solution.mjs"]);
    expect((await judge(root, test)).exitCode).not.toBe(0);
    writeFileSync(
      join(root, "worktree", "solution.mjs"),
      `const seen=new Map(); export function shouldInject(s,h,r=false) {if(!s)return true; const yes=r||seen.get(s)!==h;seen.set(s,h);return yes;}`,
    );
    const outside = fixture();
    const marker = join(outside, "oracle.txt");
    writeFileSync(marker, "unchanged");
    rmSync(join(root, "worktree", ".eval-check.mjs"));
    symlinkSync(marker, join(root, "worktree", ".eval-check.mjs"));
    expect((await judge(root, test)).exitCode).toBe(0);
    expect(readFileSync(marker, "utf8")).toBe("unchanged");
    removeAuth(root);
    expect(() => readFileSync(join(root, "home", ".codex", "auth.json"))).toThrow();
  });

  it("copies selected skills and owns a separate Git repository and worktree", () => {
    const root = fixture();
    rmSync(join(root, "worktree"), { recursive: true });
    const test = cases.find((c: { id: string }) => c.id === "memory-card");
    const condition = prepare(root, test, { skills: "plain", instructions: "scripts/evals/trimmed.md" });
    expect(condition.skills.every((s: { class: string }) => s.class === "product")).toBe(true);
    expect(readFileSync(join(root, "worktree", ".git"), "utf8")).toContain(join(root, "seed", ".git"));
    expect(readFileSync(join(root, "worktree", "AGENTS.md"), "utf8")).toBe(
      readFileSync(join(root, "worktree", ".eval-instructions.md"), "utf8"),
    );
  });
});
