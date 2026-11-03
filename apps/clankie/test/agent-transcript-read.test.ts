import type { HerdrTranscriptEntry } from "@clankie/agent-transcript";
import { expect, it } from "vitest";
import {
  TRANSCRIPT_WAITING_CALL_HEADING,
  TRANSCRIPT_WAITING_HEADING,
  TRANSCRIPT_WAITING_UNSHOWN,
  transcriptWaiting,
} from "../src/captain/agent-transcript-read.ts";

// #328: what a blocked Claude Code or Codex agent waits on. A hire's screen is its own; an
// agent the owner started is never read from its screen, only from the calls open in its session.
const prompt = (id: string, text: string): HerdrTranscriptEntry => ({
  type: "message",
  id,
  role: "operator",
  text,
});
const tool = (
  id: string,
  toolCallId: string,
  phase: "started" | "completed" | "failed",
  detail?: string,
): HerdrTranscriptEntry => ({ type: "tool", id, toolCallId, name: "Bash", phase, detail });

it("names the calls the agent started and hasn't finished since its last prompt", () => {
  const entries = [
    tool("t0", "old", "started", "before the prompt"),
    prompt("p1", "Clean up"),
    tool("t1", "done", "started", "ls"),
    tool("t2", "done", "completed", "a b"),
    tool("t3", "open", "started", "rm build.log"),
  ];
  expect(transcriptWaiting(entries, undefined)).toBe(
    `${TRANSCRIPT_WAITING_CALL_HEADING}\n· Bash rm build.log`,
  );
});

it("says the prompt isn't shown when no call is open, even after an interrupted one", () => {
  expect(transcriptWaiting([prompt("p1", "Hi")], undefined)).toBe(TRANSCRIPT_WAITING_UNSHOWN);
  const interrupted = [tool("t1", "cut", "started", "sleep 9"), { type: "interrupted", id: "i1" } as const];
  expect(transcriptWaiting(interrupted, undefined)).toBe(TRANSCRIPT_WAITING_UNSHOWN);
});

it("shows a hire's screen rows as they are, and nothing for a blank screen", () => {
  const entries = [tool("t1", "open", "started", "rm x")];
  expect(transcriptWaiting(entries, "Allow?\n\n 1. Yes\n")).toBe(
    `${TRANSCRIPT_WAITING_HEADING}\nAllow?\n 1. Yes`,
  );
  expect(transcriptWaiting(entries, "\n  \n")).toBeUndefined();
});
