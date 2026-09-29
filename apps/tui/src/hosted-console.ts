import { runAccountsCommand } from "./command/accounts.ts";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { OperatorConversationIdSchema } from "@clankie/protocol";
import { join } from "node:path";
import {
  createDefaultCredentialStore,
  beginClankieAccountLogin,
  completeClankieAccountLogin,
} from "@clankie/credential-broker";
import { SettingsStore } from "@clankie/settings";
import { ClankieFaceShell, type FaceShellCommand } from "./shell/shell.ts";
import {
  createCaptainOperatorConversationClient,
  createCaptainRouteClient,
  OperatorConversationPromptSession,
  OperatorConversationSelection,
  OperatorConversationTailStore,
  parseDirectConversation,
} from "./session/operator-conversations.ts";
import { createOperatorConversationShellSink } from "./session/operator-conversation-renderer.ts";
import {
  createHostedTransport,
  disconnectHosted,
  loadHostedSession,
  pairHostedAccount,
} from "./hosted-session.ts";
import { hostedCommand, HOSTED_LOCAL_ONLY } from "./command/hosted.ts";
import { clankieStateHome } from "./state-home.ts";

/** The connection picker is shared by /settings, /connect hosted and /gateway's guard. */
export function buildHostedConnectionCommands(
  settings: SettingsStore,
  settingsAlias = false,
): FaceShellCommand[] {
  return [
    {
      name: "connection",
      aliases: settingsAlias ? ["settings"] : [],
      description: "Choose local or hosted Clankie",
      takesArgument: false,
      async run(_argument, shell) {
        const flow = shell.setupFlow;
        flow.begin("connection");
        try {
          const current = (await settings.load()).client;
          const action = await flow.readSelect({
            message: `Connection · ${current?.mode ?? "local"}`,
            options: [
              { value: "hosted", label: "Connect to my hosted Clankie", hint: "email + one-time code" },
              { value: "local", label: "This Mac" },
            ],
          });
          const store = createDefaultCredentialStore();
          if (action === "local") await disconnectHosted(settings, store);
          else if (action === "hosted") {
            const email = await flow.readText({ message: "Clankie account email" });
            if (!email) return;
            const gatewayUrl = current?.mode === "hosted" ? current.gatewayUrl : "https://api.clankie.bot";
            const challenge = await beginClankieAccountLogin({ gatewayUrl, email });
            const code = await flow.readSecret({ message: "Code from your email" });
            if (!code) return;
            const credential = await completeClankieAccountLogin({ challenge, code });
            await pairHostedAccount({
              gatewayUrl,
              credential,
              settings,
              store,
              onStatus: (status) => flow.setStatus(status),
              selectMachine: async (machines) => {
                if (machines.length === 1) return machines[0]!;
                const id = await flow.readSelect({
                  message: "Hosted machine",
                  options: machines.map((machine) => ({
                    value: machine.id,
                    label: machine.name,
                    hint: machine.state,
                  })),
                });
                const machine = machines.find((item) => item.id === id);
                if (!machine) throw new Error("No machine selected");
                return machine;
              },
            });
          } else return;
          flow.renderLine(
            "Connection saved. Exit this console and run clankie again. Existing work continues.",
            "success",
          );
        } finally {
          flow.end();
        }
      },
    },
  ];
}

export async function runHostedConsole() {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error("The TUI requires a TTY; use clankie conversations or clankie send headlessly");
  const store = createDefaultCredentialStore(),
    settings = new SettingsStore();
  const session = await loadHostedSession(store),
    transport = createHostedTransport(session, store);
  const client = createCaptainOperatorConversationClient(createCaptainRouteClient(transport));
  const selection = new OperatorConversationSelection(client);
  const saved = (await settings.load()).client;
  if (
    saved?.mode !== "hosted" ||
    saved.hostId !== session.encryption.hostId ||
    saved.gatewayUrl !== session.gatewayUrl
  )
    throw new Error("Hosted connection identity mismatch; clankie login");
  const state = join(clankieStateHome(), "clankie", "tui", session.encryption.hostId);
  const prompt = new OperatorConversationPromptSession({
    client,
    selection,
    tails: new OperatorConversationTailStore(join(state, "tails.json")),
  });
  await prompt.initialize();
  const selectionPath = join(state, "selected-conversation.json");
  const remembered = await readFile(selectionPath, "utf8").then(
    (raw) => OperatorConversationIdSchema.parse(JSON.parse(raw)),
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return undefined;
    },
  );
  const direct = parseDirectConversation(process.argv.slice(2)).conversationId ?? remembered;
  async function remember(id: string) {
    await mkdir(state, { recursive: true, mode: 0o700 });
    await writeFile(selectionPath, JSON.stringify(id), { mode: 0o600 });
  }
  let title = "unavailable",
    notice: string | undefined;
  try {
    const conversation = direct ? await selection.select(direct) : await selection.selectDefault();
    title = conversation.title;
    await remember(conversation.conversationId);
  } catch (error) {
    notice = error instanceof Error ? error.message : String(error);
  }
  let observing: AbortController | undefined;
  let observation: Promise<void> | undefined;
  async function stopObservation() {
    observing?.abort();
    await observation;
    observing = undefined;
  }
  function observe() {
    if (!selection.conversationId || observing) return;
    const controller = new AbortController();
    observing = controller;
    observation = prompt
      .observe(createOperatorConversationShellSink(shell), controller.signal)
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          shell.insertMarkdown(
            `Hosted connection unavailable: ${error instanceof Error ? error.message : String(error)}. Use /reconnect.`,
          );
      })
      .finally(() => {
        if (observing === controller) observing = undefined;
      });
  }
  const show = async (args: string[]) =>
    shell.insertCommandResult(
      `/${args.join(" ")}`,
      JSON.stringify(await hostedCommand(args, transport), null, 2),
      "success",
    );
  const commands: FaceShellCommand[] = [
    ...buildHostedConnectionCommands(settings),
    {
      name: "settings",
      aliases: ["setup"],
      description: "Hosted settings and connection",
      takesArgument: false,
      async run(_argument, active) {
        const flow = active.setupFlow;
        flow.begin("settings");
        let selected;
        try {
          selected = await flow.readSelect({
            message: "Hosted settings",
            options: [
              { value: "connection", label: "Connection" },
              { value: "persona", label: "Persona" },
              { value: "model", label: "Model" },
              { value: "connect", label: "Connected accounts" },
            ],
          });
        } finally {
          flow.end();
        }
        if (selected) await commands.find((command) => command.name === selected)?.run("", active);
      },
    },
    {
      name: "fleet",
      aliases: [],
      description: "Hosted fleet",
      takesArgument: false,
      async run() {
        await show(["fleet"]);
      },
    },
    {
      name: "terminal",
      aliases: [],
      description: "Hosted terminal catalog",
      takesArgument: false,
      async run() {
        await show(["terminal"]);
        shell.insertMarkdown(
          "Use clankie terminal tail|control|input --json-stdin for protocol requests; terminal input requires a control lease.",
        );
      },
    },
    {
      name: "keys",
      aliases: ["auth"],
      description: "Hosted model keys",
      takesArgument: true,
      async run(argument, active) {
        if (!argument.trim()) return show(["keys"]);
        const flow = active.setupFlow;
        flow.begin("keys");
        try {
          const key = await flow.readSecret({ message: `API key for ${argument.trim()}` });
          if (key)
            active.insertCommandResult(
              "/keys",
              JSON.stringify(
                await transport.request("/v1/model-keys/set", { providerId: argument.trim(), apiKey: key }),
              ),
              "success",
            );
        } finally {
          flow.end();
        }
      },
    },
    {
      name: "conversation",
      aliases: ["conversations"],
      description: "List or select a hosted conversation",
      takesArgument: true,
      async run(argument) {
        if (!argument.trim()) {
          shell.insertCommandResult(
            "/conversation",
            (await client.list()).map((item) => `${item.conversationId}  ${item.title}`).join("\n"),
            "success",
          );
          return;
        }
        await shell.detachActiveTurn();
        await stopObservation();
        const selected = await selection.select(argument.trim());
        title = selected.title;
        await remember(selected.conversationId);
        await prompt.restoreHistory(createOperatorConversationShellSink(shell));
        observe();
        shell.refreshStatusView();
      },
    },
    {
      name: "reconnect",
      aliases: [],
      description: "Resume the same hosted conversation",
      takesArgument: false,
      async run() {
        await stopObservation();
        const selected = selection.conversationId
          ? await selection.select(selection.conversationId)
          : direct
            ? await selection.select(direct)
            : await selection.selectDefault();
        title = selected.title;
        await remember(selected.conversationId);
        await prompt.restoreHistory(createOperatorConversationShellSink(shell));
        observe();
        shell.refreshStatusView();
      },
    },
    {
      name: "logout",
      aliases: ["disconnect"],
      description: "Forget this hosted client; work continues",
      takesArgument: false,
      async run() {
        await stopObservation();
        await disconnectHosted(settings, store);
        shell.insertMarkdown(
          "Disconnected. Exit this console. Hosted work continues; revoke this device from your account to remove its access.",
        );
        disconnected = true;
      },
    },
    {
      name: "persona",
      aliases: [],
      description: "Read or edit the hosted character",
      takesArgument: true,
      async run(argument) {
        if (argument.trim() === "status") return show(["persona"]);
        const flow = shell.setupFlow;
        flow.begin("persona");
        try {
          const current = (await transport.request("/v1/operator/persona")) as {
            persona: { displayName: string; characterNotes: string; imagesDir?: string };
          };
          const displayName = await flow.readText({
            message: "Name",
            defaultValue: current.persona.displayName,
          });
          if (displayName === undefined) return;
          const characterNotes = await flow.readText({
            message: "Character notes",
            defaultValue: current.persona.characterNotes,
          });
          if (characterNotes === undefined) return;
          const imagesDir = await flow.readText({
            message: "Persona folder on hosted machine (root = vibe; appearance/ = look; blank clears)",
            defaultValue: current.persona.imagesDir ?? "",
          });
          if (imagesDir === undefined) return;
          await transport.request("/v1/operator/persona", { displayName, characterNotes, imagesDir });
          flow.renderLine("Hosted persona saved. Restart Clankie to apply persona images.", "success");
        } finally {
          flow.end();
        }
      },
    },
    {
      name: "model",
      aliases: [],
      description: "Read or select the hosted model",
      takesArgument: true,
      run: async (argument) => show(["model", ...(argument.trim() ? argument.trim().split(/\s+/u) : [])]),
    },
    {
      name: "connect",
      aliases: [],
      description: "Hosted account connections",
      takesArgument: true,
      async run(argument) {
        if (argument.trim() === "hosted")
          return commands.find((command) => command.name === "connection")!.run("", shell);
        if (!argument.trim()) return show(["accounts"]);
        const provider = argument.trim();
        if (provider === "github") {
          const flow = shell.setupFlow;
          flow.begin("connect");
          try {
            const result = await runAccountsCommand(["connect", "github"], {
              request: async (path, body) => (await transport.request(path, body)) as Record<string, unknown>,
              prompt: (line) => flow.renderLine(line, "success"),
            });
            flow.renderLine(JSON.stringify(result), "success");
          } finally {
            flow.end();
          }
          return;
        }
        if (provider === "linear") {
          const start = (await transport.request("/v1/accounts/linear/start", {})) as {
            ok: boolean;
            authorizeUrl: string;
            flowId: string;
          };
          if (!start.ok) throw new Error("Hosted Linear sign-in unavailable");
          const flow = shell.setupFlow;
          flow.begin("connect");
          try {
            const redirect = await flow.readSecret({
              message: `Open ${start.authorizeUrl}; paste the final redirect URL`,
            });
            if (!redirect) return;
            const url = new URL(redirect);
            if (url.searchParams.get("state") !== start.flowId)
              throw new Error("Linear sign-in state mismatch");
            const result = await transport.request("/v1/accounts/linear/complete", {
              state: start.flowId,
              code: url.searchParams.get("code"),
            });
            flow.renderLine(JSON.stringify(result), "success");
          } finally {
            flow.end();
          }
          return;
        }
        throw new Error(
          "Use /connect github or /connect linear. Hosted Discord is managed from your account.",
        );
      },
    },
    ...["status", "health", ...HOSTED_LOCAL_ONLY]
      .filter((name, index, values) => values.indexOf(name) === index)
      .map(
        (name): FaceShellCommand => ({
          name,
          aliases: [],
          description: HOSTED_LOCAL_ONLY.has(name) ? "Managed by the hosted service" : "Hosted status",
          takesArgument: true,
          run: async (argument) => show([name, ...argument.split(/\s+/u).filter(Boolean)]),
        }),
      ),
  ];
  let disconnected = false;
  const shell = new ClankieFaceShell({
    commands,
    cwd: process.cwd(),
    allowLocalShell: false,
    onHerdrJump: async () => ({
      outcome: "unavailable",
      error: "Use /terminal or clankie terminal for hosted terminals; no local socket is used.",
    }),
    bannerFields: { title: "Clankie" },
    historyPath: join(state, "history.jsonl"),
    footerData: () => ({ title }),
    statusExtras: () => [
      `Hosted · ${session.machine?.name ?? session.encryption.hostId}`,
      transport.status(),
    ],
    onPrompt: async (text, active, signal, delivery) => {
      if (disconnected) throw new Error("Disconnected. Exit and reconnect to continue.");
      await stopObservation();
      try {
        await prompt.prompt(
          text,
          createOperatorConversationShellSink(active, { localEchoText: text }),
          signal,
          delivery,
        );
      } finally {
        observe();
      }
    },
    onPendingPrompt: async (text, delivery) => {
      if (disconnected) throw new Error("Disconnected");
      await prompt.submit(text, delivery);
    },
    onInterrupt: () => prompt.interruptActive(),
    onExit: stopObservation,
  });
  transport.subscribe(() => shell.refreshStatusView());
  shell.start();
  shell.insertMarkdown(
    notice
      ? `Hosted Clankie unavailable: ${notice}. Use /reconnect.`
      : "Connected to your hosted Clankie. /conversation selects a retained conversation; /settings manages this connection. Closing this console leaves work running.",
  );
  if (selection.conversationId) {
    await prompt.restoreHistory(createOperatorConversationShellSink(shell));
    observe();
  }
}
