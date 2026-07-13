import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import {
  TerminalGatewayClient,
  type TerminalGatewayStreamEvent,
  type TerminalJsonConnector,
  type TerminalJsonDuplex,
} from "@clankie/api-client";
import { TerminalAccessAuthority } from "../src/terminal-access-authority.ts";
import { createTerminalGateway, TERMINAL_GATEWAY_PATH } from "../src/terminal-gateway.ts";
import { TerminalManager } from "../src/terminals.ts";

function webSocketConnector(url: string, token: string): TerminalJsonConnector {
  return async (signal): Promise<TerminalJsonDuplex> => {
    const socket = await new Promise<WebSocket>((resolve, reject) => {
      const candidate = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } });
      candidate.once("open", () => resolve(candidate));
      candidate.once("error", reject);
    });
    const queue: unknown[] = [];
    let done = false;
    let wake: (() => void) | undefined;
    const finish = (): void => {
      done = true;
      wake?.();
      wake = undefined;
    };
    socket.on("message", (data: Buffer) => {
      queue.push(JSON.parse(data.toString("utf8")) as unknown);
      wake?.();
      wake = undefined;
    });
    socket.once("close", finish);
    signal.addEventListener(
      "abort",
      () => {
        socket.terminate();
        finish();
      },
      { once: true },
    );
    return {
      send: (message) => socket.send(JSON.stringify(message)),
      async *messages() {
        for (;;) {
          const message = queue.shift();
          if (message !== undefined) yield message;
          else if (done) return;
          else await new Promise<void>((resolve) => (wake = resolve));
        }
      },
      close: () => {
        socket.terminate();
        finish();
      },
    };
  };
}

async function collect(
  stream: AsyncIterable<TerminalGatewayStreamEvent>,
): Promise<TerminalGatewayStreamEvent[]> {
  const events: TerminalGatewayStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe("TerminalGatewayClient over the real runner loopback gateway", () => {
  it("discovers and mirrors a real native PTY through one cf07 translation owner", async () => {
    const manager = new TerminalManager();
    const authority = new TerminalAccessAuthority({ secret: Buffer.alloc(32, 11) });
    const gateway = await createTerminalGateway({ manager, authority, config: { port: 0 } });
    try {
      const session = manager.spawnTerminal({
        workerRunId: "real-loopback-worker",
        title: "real loopback PTY",
        command: process.execPath,
        args: [
          "-e",
          "setTimeout(()=>{process.stdout.write('REAL-PTY-OUTPUT\\n');setTimeout(()=>process.exit(0),80)},200)",
        ],
        env: { PATH: process.env.PATH },
        columns: 91,
        rows: 27,
      });
      const token = authority.mintObserveToken({
        principalId: "principal-loopback",
        deviceId: "simulator-loopback",
        ttlMs: 10_000,
      });
      const client = new TerminalGatewayClient({
        connect: webSocketConnector(
          `ws://${gateway.address.host}:${gateway.address.port}${TERMINAL_GATEWAY_PATH}`,
          token,
        ),
        attribution: {
          principalId: "principal-loopback",
          deviceId: "simulator-loopback",
          clientInstanceId: "integration-client",
        },
      });

      await expect(client.listSessions()).resolves.toEqual([
        expect.objectContaining({ terminalId: session.id, label: "real loopback PTY", source: "runner" }),
      ]);
      const events = await collect(
        client.observe({ terminalId: session.id, signal: new AbortController().signal }),
      );
      expect(events.map(({ type }) => type)).toEqual(["capabilities", "snapshot", "output", "closed"]);
      expect(events[1]).toMatchObject({
        type: "snapshot",
        snapshot: { terminalId: session.id, geometry: { columns: 91, rows: 27 } },
      });
      expect(events[2]).toMatchObject({ type: "output", frame: { terminalId: session.id, sequence: 1 } });
      expect(
        Buffer.from(
          (events[2] as Extract<TerminalGatewayStreamEvent, { type: "output" }>).frame.dataBase64,
          "base64",
        ).toString(),
      ).toContain("REAL-PTY-OUTPUT");
      expect(events[3]).toMatchObject({ type: "closed", reason: "exited" });
    } finally {
      await gateway.close();
    }
  });
});
