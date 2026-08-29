import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import type { DiscordVoiceTranscriptLogEntry, DiscordVoiceTranscriptPage } from "@clankie/protocol";
import { buildConsoleCommands } from "../src/commands.ts";
import { ClankieVoiceTranscriptOverlay } from "../src/face/clankie-voice-transcripts.ts";
import type { ClankieFaceShell } from "../src/shell/shell.ts";
import {
  createDiscordVoiceTranscriptClient,
  followVoiceTranscripts,
  formatVoiceTranscriptAge,
  formatVoiceTranscriptLines,
  voiceTranscriptEntryKey,
} from "../src/session/voice-transcripts.ts";

const NOW = Date.parse("2026-08-29T16:20:00.000Z");

function entry(
  overrides: Partial<DiscordVoiceTranscriptLogEntry> &
    Pick<DiscordVoiceTranscriptLogEntry, "deliveryId" | "text">,
): DiscordVoiceTranscriptLogEntry {
  return {
    schemaVersion: 1,
    body: "bot",
    occurredAt: "2026-08-29T16:16:02.964Z",
    guildId: "866430493889134672",
    channelId: "866430493889134676",
    speakerId: "830574404453793842",
    displayName: "vuhlp",
    ...overrides,
  };
}

function page(
  overrides: Partial<DiscordVoiceTranscriptPage> & Pick<DiscordVoiceTranscriptPage, "entries">,
): DiscordVoiceTranscriptPage {
  return {
    schemaVersion: 1,
    enabled: true,
    nextCursor: "000000000001",
    hasMore: false,
    ...overrides,
  };
}

const theme = {
  bold: (text: string) => text,
  cyan: (text: string) => text,
  dim: (text: string) => text,
  green: (text: string) => text,
  red: (text: string) => text,
  yellow: (text: string) => text,
};

function stripAnsi(text: string): string {
  // oxlint-disable-next-line no-control-regex -- intentionally strips ANSI escape sequences
  return text.replace(/\x1b\[[0-9;:?]*[ -/]*[@-~]/gu, "");
}

function expectFits(lines: readonly string[], width: number): void {
  for (const line of lines) {
    expect(visibleWidth(line), `line should fit width ${width}: ${JSON.stringify(line)}`).toBeLessThanOrEqual(
      width,
    );
  }
}

describe("discord voice transcript client", () => {
  it("parses the authenticated page", async () => {
    const first = entry({ deliveryId: "delivery-1", text: "Are you there?" });
    const client = createDiscordVoiceTranscriptClient({
      fetch: async (path) => {
        expect(path).toBe("/v1/discord/voice-transcripts?limit=100");
        return new Response(JSON.stringify(page({ entries: [first], enabled: true })), {
          headers: { "content-type": "application/json" },
        });
      },
    });
    await expect(client.read()).resolves.toMatchObject({ enabled: true, entries: [first] });
  });

  it("passes a cursor when following later pages", async () => {
    const client = createDiscordVoiceTranscriptClient({
      fetch: async (path) => {
        expect(path).toBe("/v1/discord/voice-transcripts?limit=50&cursor=000000000012");
        return new Response(JSON.stringify(page({ entries: [], nextCursor: "000000000012" })));
      },
    });
    await expect(client.read({ cursor: "000000000012", limit: 50 })).resolves.toMatchObject({
      enabled: true,
      entries: [],
    });
  });

  it("rejects a page that fails the public schema", async () => {
    const client = createDiscordVoiceTranscriptClient({
      fetch: async () => new Response(JSON.stringify({ schemaVersion: 1, enabled: true, entries: [{}] })),
    });
    await expect(client.read()).rejects.toThrow(/schema validation/u);
  });

  it("surfaces an unauthorized listing as an error rather than an empty log", async () => {
    const client = createDiscordVoiceTranscriptClient({
      fetch: async () => new Response("", { status: 401 }),
    });
    await expect(client.read()).rejects.toThrow(/401/u);
  });
});

describe("voice transcript formatting", () => {
  it("reprints a dim room header only when the body or channel changes", () => {
    const lines = formatVoiceTranscriptLines(
      [
        entry({ deliveryId: "d1", text: "Thank you" }),
        entry({ deliveryId: "d2", text: "Are you there?", occurredAt: "2026-08-29T16:16:27.957Z" }),
        entry({
          deliveryId: "d3",
          text: "hello from lab",
          body: "user_session",
          displayName: "James",
        }),
      ],
      { now: NOW },
    );
    expect(lines).toEqual([
      "bot · 866430493889134672:866430493889134676",
      "vuhlp · 3m",
      "Thank you",
      "vuhlp · 3m",
      "Are you there?",
      "",
      "user_session · 866430493889134672:866430493889134676",
      "James · 3m",
      "hello from lab",
    ]);
  });

  it("falls back to the speaker id when no display name is present", () => {
    const lines = formatVoiceTranscriptLines(
      [entry({ deliveryId: "d1", text: "yo", displayName: undefined })],
      { now: NOW },
    );
    expect(lines[1]).toBe("830574404453793842 · 3m");
  });

  it("keys relative age off the supplied now", () => {
    expect(formatVoiceTranscriptAge("2026-08-29T16:19:30.000Z", NOW)).toBe("now");
    expect(formatVoiceTranscriptAge("2026-08-29T15:20:00.000Z", NOW)).toBe("1h");
    expect(formatVoiceTranscriptAge("2026-08-23T16:20:00.000Z", NOW)).toBe("6d");
    expect(formatVoiceTranscriptAge("2026-08-22T16:20:00.000Z", NOW)).toBe("2026-08-22");
  });
});

describe("followVoiceTranscripts", () => {
  it("reports the recent tail then only newly appended entries", async () => {
    const snapshots: Array<{ enabled: boolean; texts: string[] }> = [];
    const controller = new AbortController();
    const first = entry({ deliveryId: "d1", text: "one" });
    const second = entry({ deliveryId: "d2", text: "two" });
    const pages = [
      page({ entries: [first], nextCursor: "000000000001" }),
      page({ entries: [second], nextCursor: "000000000002" }),
    ];
    let listed = 0;
    await followVoiceTranscripts({
      client: {
        read: async (options) => {
          const index = Math.min(listed, pages.length - 1);
          listed += 1;
          if (listed === 1) expect(options?.cursor).toBeUndefined();
          if (listed === 2) expect(options?.cursor).toBe("000000000001");
          return pages[index]!;
        },
      },
      signal: controller.signal,
      sleep: async () => {
        if (listed >= 2) controller.abort();
      },
      onSnapshot: (snapshot) => {
        snapshots.push({ enabled: snapshot.enabled, texts: snapshot.entries.map((item) => item.text) });
      },
    });
    expect(snapshots.map((item) => item.texts)).toEqual([["one"], ["one", "two"]]);
  });

  it("backs off while the log is quiet and snaps back when it changes", async () => {
    const waits: number[] = [];
    const controller = new AbortController();
    const initial = entry({ deliveryId: "d1", text: "one" });
    const appended = entry({ deliveryId: "d2", text: "two" });
    let listed = 0;
    await followVoiceTranscripts({
      client: {
        read: async () => {
          listed += 1;
          return listed < 4
            ? page({ entries: listed === 1 ? [initial] : [], nextCursor: "000000000001" })
            : page({ entries: [appended], nextCursor: "000000000002" });
        },
      },
      signal: controller.signal,
      pollIntervalMs: 1_000,
      sleep: async (ms) => {
        waits.push(ms);
        if (listed >= 4) controller.abort();
      },
      onSnapshot: () => undefined,
    });
    expect(waits).toEqual([1_000, 1_000, 2_000, 1_000]);
  });

  it("clears the snapshot when retention is disabled", async () => {
    const snapshots: Array<{ enabled: boolean; count: number }> = [];
    const controller = new AbortController();
    let listed = 0;
    await followVoiceTranscripts({
      client: {
        read: async () => {
          listed += 1;
          if (listed === 1) {
            return page({ entries: [entry({ deliveryId: "d1", text: "private" })] });
          }
          return page({ enabled: false, entries: [], nextCursor: "000000000000" });
        },
      },
      signal: controller.signal,
      sleep: async () => {
        if (listed >= 2) controller.abort();
      },
      onSnapshot: (snapshot) => {
        snapshots.push({ enabled: snapshot.enabled, count: snapshot.entries.length });
      },
    });
    expect(snapshots).toEqual([
      { enabled: true, count: 1 },
      { enabled: false, count: 0 },
    ]);
  });

  it("does not re-emit a quiet snapshot", async () => {
    const snapshots: number[] = [];
    const controller = new AbortController();
    let listed = 0;
    await followVoiceTranscripts({
      client: {
        read: async () => {
          listed += 1;
          return page({
            entries: listed === 1 ? [entry({ deliveryId: "d1", text: "one" })] : [],
            nextCursor: "000000000001",
          });
        },
      },
      signal: controller.signal,
      sleep: async () => {
        if (listed >= 3) controller.abort();
      },
      onSnapshot: () => {
        snapshots.push(listed);
      },
    });
    expect(snapshots).toEqual([1]);
  });

  it("keeps following after a listing failure and reports it once", async () => {
    const notices: string[] = [];
    const controller = new AbortController();
    let calls = 0;
    await followVoiceTranscripts({
      client: {
        read: async () => {
          calls += 1;
          if (calls === 1) throw new Error("captain unreachable");
          return page({ entries: [] });
        },
      },
      signal: controller.signal,
      sleep: async () => {
        if (calls >= 2) controller.abort();
      },
      onSnapshot: () => undefined,
      onNotice: (message) => {
        notices.push(message);
      },
    });
    expect(notices).toEqual(["captain unreachable"]);
  });
});

describe("voice transcript overlay", () => {
  it("points at /discord when logging is disabled and closes on escape", () => {
    let closed = false;
    const overlay = new ClankieVoiceTranscriptOverlay(
      {
        onClose: () => {
          closed = true;
        },
        onRender: () => undefined,
      },
      theme,
    );
    overlay.setSnapshot({ enabled: false, entries: [] }, NOW);
    const disabled = overlay.render(72).map(stripAnsi);
    expect(disabled.some((line) => line.includes("Enable it in /discord"))).toBe(true);
    expectFits(overlay.render(72), 72);

    overlay.setSnapshot({ enabled: true, entries: [] }, NOW);
    expect(
      overlay
        .render(48)
        .map(stripAnsi)
        .some((line) => line.includes("Listening for retained speech")),
    ).toBe(true);

    overlay.setSnapshot(
      {
        enabled: true,
        entries: [
          entry({ deliveryId: "d1", text: "older line", occurredAt: "2026-08-29T16:10:00.000Z" }),
          entry({ deliveryId: "d2", text: "Are you there?" }),
        ],
      },
      NOW,
    );
    const live = overlay.render(64).map(stripAnsi).join("\n");
    expect(live).toContain("vuhlp");
    expect(live).toContain("Are you there?");
    expect(live).toContain("bot ·");
    expect(live.indexOf("Are you there?")).toBeLessThan(live.indexOf("older line"));
    expectFits(overlay.render(64), 64);

    overlay.handleInput("\x1b");
    expect(closed).toBe(true);
  });
});

describe("vt console command", () => {
  it("opens the overlay and /vt off closes it", () => {
    const events: string[] = [];
    const command = buildConsoleCommands({}).find((candidate) => candidate.name === "vt");
    if (command === undefined) throw new Error("vt command not found");
    expect(command.aliases).toEqual(["voice-log", "voice-transcripts"]);
    const shell = {
      openVoiceTranscripts() {
        events.push("open");
        return true;
      },
      closeVoiceTranscripts() {
        events.push("close");
      },
      insertCommandResult(invocation: string, text: string, tone: string) {
        events.push(`${tone}:${invocation}:${text}`);
      },
    } as ClankieFaceShell;

    command.run("", shell);
    command.run("off", shell);
    command.run("nope", shell);

    expect(events).toEqual([
      "open",
      "close",
      "success:/vt off:Closed the voice transcript tail.",
      "error:/vt nope:Usage: /vt [off]",
    ]);
  });

  it("surfaces a missing listing instead of opening an empty overlay", () => {
    const results: Array<{ command: string; text: string; tone: string }> = [];
    const command = buildConsoleCommands({}).find((candidate) => candidate.name === "vt");
    if (command === undefined) throw new Error("vt command not found");
    const shell = {
      openVoiceTranscripts() {
        return false;
      },
      insertCommandResult(invocation: string, text: string, tone: string) {
        results.push({ command: invocation, text, tone });
      },
    } as ClankieFaceShell;

    command.run("", shell);
    expect(results).toEqual([
      {
        command: "/vt",
        tone: "error",
        text: "Clankie's voice transcript listing is unavailable.",
      },
    ]);
  });
});

describe("voice transcript keys", () => {
  it("joins body and delivery so bot and lab lines do not collide", () => {
    expect(voiceTranscriptEntryKey(entry({ deliveryId: "d1", text: "x" }))).toBe("bot:d1");
  });
});
