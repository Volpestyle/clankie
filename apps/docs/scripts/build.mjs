import { cp, glob, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { marked } from "marked";
import { parse as parseYaml } from "yaml";
import {
  PUBLIC_GATEWAY_CONFIG_PATH,
  PUBLIC_GATEWAY_HEALTH_PATH,
  PUBLIC_GATEWAY_HOST_CONNECT_PATH,
  PUBLIC_GATEWAY_ROUTES,
} from "../../../packages/protocol/src/public-gateway.ts";
import {
  DEVICE_PUSH_PATH,
  PUBLIC_GATEWAY_PUSH_CLEAR_PATH,
  PUBLIC_GATEWAY_PUSH_REGISTRATIONS_PATH,
} from "../../../packages/protocol/src/device-push.ts";

const appRoot = resolve(import.meta.dirname, "..");
const repoRoot = resolve(appRoot, "../..");
const sourceDir = resolve(appRoot, "site");
const contentDir = resolve(appRoot, "content");
const templateDir = resolve(appRoot, "templates");
const defaultOutputDir = resolve(appRoot, "dist");

const SITE = "https://docs.clankie.bot";
const REPO = "https://github.com/Volpestyle/clankie";
const REPO_BLOB = `${REPO}/blob/main`;

/** One header for every page; `optional` links hide on narrow screens, `narrow` links show only there. */
const NAV = [
  { href: "/get-started/", label: "Start" },
  { href: "/using-clankie/", label: "Using Clankie", optional: true },
  { href: "/diy/", label: "DIY" },
  { href: "/how-it-works/", label: "How he works", optional: true },
  { href: "/reference/", label: "Reference" },
  { href: "https://clankie.bot/support/", label: "Support", optional: true },
];

/** Every page the site publishes, in sitemap and llms.txt order. */
const PAGES = [
  {
    path: "/",
    title: "Clankie field guide",
    description: "Everyday help and deeper possibilities, with clear paths for hosted and DIY users.",
  },
  {
    path: "/get-started/",
    title: "Get started",
    description: "Start with hosted Clankie in the app, or install and configure your own Mac.",
  },
  {
    path: "/using-clankie/",
    title: "Using Clankie",
    description: "Everyday requests, memory, creative work, helper agents, and the app.",
  },
  {
    path: "/diy/",
    title: "Customize Clankie",
    description:
      "Choose models, skills, coding agents, services, Discord, voice, and play on your own machine.",
  },
  {
    path: "/reference/",
    title: "Reference",
    description: "Find the console, CLI, API, and canonical technical references by task.",
  },
  {
    path: "/how-it-works/",
    title: "How he works",
    description: "One persistent service, its conversations, memory, models, tools, and connections.",
  },
  {
    path: "/console/",
    title: "Console",
    description:
      "Every slash command and key in the operator console, generated from the console's own registry.",
  },
  {
    path: "/cli/",
    title: "CLI",
    description: "The headless clankie command contract: flags, JSON on stdout, exit codes.",
  },
  {
    path: "/api/",
    title: "HTTP API",
    description: "The local service catalog on 127.0.0.1:4310, generated from the OpenAPI document.",
  },
  {
    path: "/network/",
    title: "Network",
    description: "The exact public routes at api.clankie.bot and the authorization each one requires.",
  },
];

/** Counts reported after a build; set by the console and API renderers. */
let slashCommandCount = 0;
let apiOperationCount = 0;

export async function buildPublicDocs(outputDir = defaultOutputDir) {
  await rm(outputDir, { recursive: true, force: true });
  await cp(sourceDir, outputDir, { recursive: true });
  await mkdir(resolve(outputDir, "assets"), { recursive: true });
  await cp(
    resolve(repoRoot, "branding/clankie-logo-512-alpha.png"),
    resolve(outputDir, "assets/clankie.png"),
  );

  const network = buildNetworkRows();
  await fillMarker(
    resolve(outputDir, "network/index.html"),
    "{{PUBLIC_GATEWAY_TABLE}}",
    network.rows.map(networkRow).join(""),
  );

  const template = await readFile(resolve(templateDir, "page.html"), "utf8");
  const architecture = await readFile(resolve(repoRoot, "docs/architecture.md"), "utf8");
  const sources = {
    "/get-started/": await readContent("get-started.md"),
    "/using-clankie/": await readContent("using-clankie.md"),
    "/diy/": await readContent("diy.md"),
    "/reference/": await readContent("reference.md"),
    "/how-it-works/": await readContent("how-it-works.md"),
    "/console/": await consoleMarkdown(),
    "/cli/": absolutizeLinks(
      await readFile(resolve(repoRoot, "docs/cli.md"), "utf8"),
      resolve(repoRoot, "docs"),
    ),
    "/api/": await apiMarkdown(),
    "/": await staticPageContent(resolve(outputDir, "index.html")),
    "/network/": await staticPageContent(resolve(outputDir, "network/index.html")),
  };
  for (const page of PAGES) {
    if (page.path === "/" || page.path === "/network/") continue;
    const rendered = renderMarkdown(sources[page.path]);
    const html = template
      .replaceAll("{{TITLE}}", escapeHtml(page.title))
      .replaceAll("{{DESCRIPTION}}", escapeHtml(page.description))
      .replaceAll("{{CANONICAL}}", `${SITE}${page.path}`)
      .replace("{{CONTENT}}", () => rendered);
    const dir = resolve(outputDir, page.path.slice(1));
    await mkdir(dir, { recursive: true });
    await writeFile(resolve(dir, "index.html"), html);
  }
  await cp(resolve(repoRoot, "apps/clankie/openapi.yaml"), resolve(outputDir, "api/openapi.yaml"));

  for await (const file of glob("**/*.html", { cwd: outputDir })) {
    const path = resolve(outputDir, file);
    await fillMarker(path, "{{NAV}}", navHtml(`/${file.replace(/index\.html$/, "")}`));
  }

  await writeFile(resolve(outputDir, "sitemap.xml"), sitemap());
  await writeFile(resolve(outputDir, "llms.txt"), llmsIndex());
  await writeFile(
    resolve(outputDir, "llms-full.txt"),
    llmsFull([
      sources["/"],
      sources["/get-started/"],
      sources["/using-clankie/"],
      sources["/diy/"],
      sources["/reference/"],
      sources["/how-it-works/"],
      sources["/console/"],
      sources["/cli/"],
      sources["/api/"],
      sources["/network/"],
      absolutizeLinks(architecture, resolve(repoRoot, "docs")),
    ]),
  );

  console.log(
    `Built public docs: ${PAGES.length} pages, ${network.rows.length} network routes, ${apiOperationCount} API operations, ${slashCommandCount} slash commands.`,
  );
}

// --- network -----------------------------------------------------------------

function buildNetworkRows() {
  const routeDetails = new Map([
    [
      "POST /v1/activity/viewer",
      {
        access: "Fleet-signed Activity media permit with current audience authorization",
        purpose: "Read the scoped hosted Activity stream while its live audience remains authorized.",
      },
    ],
    [
      "GET /v1/operator/fleet-settings",
      {
        access: "Encrypted active device bearer with terminalControl (Take Control)",
        purpose: "Read global fleet defaults and owner working preferences with their current revision.",
      },
    ],
    [
      "POST /v1/operator/fleet-settings",
      {
        access: "Encrypted active device bearer with terminalControl (Take Control)",
        purpose:
          "Update global fleet defaults and working preferences with revision and current-authority fencing.",
      },
    ],
    [
      "GET /v1/operator/fleet-settings/hire",
      {
        access: "Encrypted active device bearer with terminalControl (Take Control)",
        purpose: "Read harness, model and effort defaults; omitted fields leave the choice to Clankie.",
      },
    ],
    [
      "POST /v1/operator/fleet-settings/hire",
      {
        access: "Encrypted active device bearer with terminalControl (Take Control)",
        purpose: "Update hire defaults against the whole hire profile revision; auto clears a preference.",
      },
    ],
    [
      "GET /v1/worker-accounts",
      {
        access: "Encrypted active device bearer with terminalControl (Take Control)",
        purpose:
          "Read sign-in, identity, usage headroom and holds for this machine or the named fleet connection; never credentials.",
      },
    ],
    [
      "POST /v1/worker-accounts/holds",
      {
        access: "Encrypted active device bearer with terminalControl (Take Control)",
        purpose:
          "Hold or release one account for automatic hiring; an explicitly selected account remains usable.",
      },
    ],
    [
      "GET /v1/operator/persona",
      {
        access: "Encrypted active device bearer with terminalControl (Take Control)",
        purpose:
          "Read chattiness and reply policy; account-paired hosted operators retain full persona access.",
      },
    ],
    [
      "POST /v1/operator/persona",
      {
        access: "Encrypted active device bearer with terminalControl (Take Control)",
        purpose: "Update chattiness and reply policy; other persona fields require operator authority.",
      },
    ],
    [
      "GET /v1/operator/projects",
      {
        access: "Encrypted active device bearer with terminalControl (Take Control)",
        purpose: "Read approved projects and opt into independently inherited working preferences.",
      },
    ],
    [
      "POST /v1/operator/projects/update",
      {
        access: "Encrypted active device bearer with terminalControl (Take Control)",
        purpose:
          "Edit existing project settings and clear individual overrides through revision-fenced owner access.",
      },
    ],
    [
      "GET /v1/model-keys",
      {
        access: "Encrypted active device bearer with terminalControl (Take Control)",
        purpose:
          "Read the supported model catalog, Clankie model selection and stored-key status, never keys.",
      },
    ],
    [
      "POST /v1/model-keys/set",
      {
        access: "Encrypted active device bearer with terminalControl (Take Control)",
        purpose: "Store or replace a provider API key in the body credential broker.",
      },
    ],
    [
      "POST /v1/model-keys/validate",
      {
        access: "Encrypted active device bearer with terminalControl (Take Control)",
        purpose:
          "Check a stored provider key with a bounded provider request; return only a success or error code.",
      },
    ],
    [
      "POST /v1/model-keys/select",
      {
        access: "Encrypted active device bearer with terminalControl (Take Control)",
        purpose: "Choose Clankie’s model for its next turn using the shared CLI config.",
      },
    ],
    [
      "GET /v1/model-keys/subscriptions",
      {
        access: "Encrypted active device bearer with terminalControl (Take Control)",
        purpose:
          "Name the providers signed in through an account (OAuth or subscription), without token details.",
      },
    ],
    [
      "GET /v1/model-keys/subscriptions/methods",
      {
        access: "Encrypted active device bearer with terminalControl (Take Control)",
        purpose: "List sign-in methods allowed by the body's provider policy.",
      },
    ],
    [
      "POST /v1/model-keys/subscriptions/start",
      {
        access: "Encrypted active device bearer with terminalControl (Take Control)",
        purpose: "Start a provider sign-in for this device and its chosen catalog model.",
      },
    ],
    [
      "POST /v1/model-keys/subscriptions/status",
      {
        access: "Encrypted initiating device bearer with terminalControl (Take Control)",
        purpose: "Read this device's transient browser URL/code or sign-in outcome.",
      },
    ],
    [
      "GET /v1/harness-logins",
      {
        access: "Encrypted active device bearer with terminalControl (Take Control)",
        purpose: "Read whether the Claude Code and Codex worker harnesses are installed and signed in.",
      },
    ],
    [
      "POST /v1/harness-logins/start",
      {
        access: "Encrypted active device bearer with terminalControl (Take Control)",
        purpose:
          "Start a worker harness's own login (Claude subscription or Codex device code) for this device.",
      },
    ],
    [
      "POST /v1/harness-logins/status",
      {
        access: "Encrypted initiating device bearer with terminalControl (Take Control)",
        purpose: "Read this device's transient login link/code or the harness sign-in outcome.",
      },
    ],
    [
      "POST /v1/harness-logins/code",
      {
        access: "Encrypted initiating device bearer with terminalControl (Take Control)",
        purpose: "Send the code Claude's sign-in page showed to the waiting login.",
      },
    ],
    [
      "POST /v1/harness-logins/cancel",
      {
        access: "Encrypted initiating device bearer with terminalControl (Take Control)",
        purpose: "Cancel this device's pending worker harness sign-in.",
      },
    ],
    [
      "POST /v1/model-keys/subscriptions/cancel",
      {
        access: "Encrypted initiating device bearer with terminalControl (Take Control)",
        purpose: "Cancel a pending sign-in before its credential write is admitted.",
      },
    ],
    [
      "GET /v1/model-keys/options",
      {
        access: "Encrypted active device bearer with terminalControl (Take Control)",
        purpose:
          "Name the providers that can serve a turn now and the running model's reasoning effort, without credentials.",
      },
    ],
    [
      "POST /v1/model-keys/effort",
      {
        access: "Encrypted active device bearer with terminalControl (Take Control)",
        purpose: "Set or clear the running model's reasoning effort using the shared CLI config.",
      },
    ],
    [
      "POST /v1/model-keys/remove",
      {
        access: "Encrypted active device bearer with terminalControl (Take Control)",
        purpose: "Remove a stored provider API key without exposing it.",
      },
    ],
    [
      "GET /v1/accounts",
      {
        access: "Encrypted active device bearer with terminalControl (Take Control)",
        purpose:
          "Read the body-owned GitHub, Linear and Google catalog with account, grants and recovery status, never tokens.",
      },
    ],
    [
      "POST /v1/accounts/github/start",
      {
        access: "Encrypted active device bearer with terminalControl (Take Control)",
        purpose: "Start a GitHub device flow on the body; return the user code and verification URL.",
      },
    ],
    [
      "POST /v1/accounts/github/poll",
      {
        access: "Encrypted active device bearer with terminalControl (Take Control)",
        purpose: "Poll a pending GitHub device flow; the body stores the token in its credential broker.",
      },
    ],
    [
      "POST /v1/accounts/linear/start",
      {
        access: "Encrypted active device bearer with terminalControl (Take Control)",
        purpose: "Start a Linear OAuth PKCE flow; the verifier stays on the body.",
      },
    ],
    [
      "POST /v1/accounts/linear/complete",
      {
        access: "Encrypted active device bearer with terminalControl (Take Control)",
        purpose: "Hand the Linear authorization code to the body, which exchanges it with its verifier.",
      },
    ],
    [
      "POST /v1/accounts/linear/app",
      {
        access: "Encrypted device bearer with terminal-control access",
        purpose: "Verify and connect a workspace-owned Linear app; client credentials stay on the host.",
      },
    ],
    [
      "POST /v1/accounts/google/start",
      {
        access: "Encrypted active device bearer with terminalControl (Take Control)",
        purpose:
          "Start body-owned Google consent for Gmail, Calendar or selected-file Drive access, with state and PKCE.",
      },
    ],
    [
      "POST /v1/accounts/google/complete",
      {
        access: "Encrypted active device bearer with terminalControl (Take Control)",
        purpose:
          "Exchange the one-time Google code and selected Drive file IDs on the body; return identity and grants without tokens.",
      },
    ],
    [
      "POST /v1/accounts/google/check",
      {
        access: "Encrypted active device bearer with terminalControl (Take Control)",
        purpose:
          "Refresh and verify the selected Google account's authorized access and return its recovery status.",
      },
    ],
    [
      "POST /v1/accounts/disconnect",
      {
        access: "Encrypted active device bearer with terminalControl (Take Control)",
        purpose:
          "Disable local account access and attempt provider revocation; Google disconnect disables all three Google connections and reports pending revocation if needed.",
      },
    ],
    [
      "POST /operator/v1/artifacts/download",
      {
        access: "Encrypted device bearer plus chat grant",
        purpose: "Download exact bytes of a delivered artifact scoped to its conversation.",
      },
    ],
    [
      "GET /v1/gateway/challenge",
      {
        access: "Host routing identity; no device bearer",
        purpose: "Obtain a one-use challenge for an encrypted device exchange.",
      },
    ],
    [
      "POST /v1/gateway/encrypted",
      {
        access: "Authenticated device-to-host AES-GCM envelope",
        purpose:
          "Carry pairing, conversation, control, artifact and terminal traffic without revealing application bytes to the gateway.",
      },
    ],
    [
      "POST /v1/gateway/push-authorize",
      {
        access: "Gateway-internal one-use encrypted device proof",
        purpose: "Authorize push delivery at the device’s Mac without exposing its bearer.",
      },
    ],
    [
      "POST /v1/pairing/redeem",
      {
        access: "One-time offer secret inside the authenticated pairing envelope",
        purpose: "Claim an active pairing offer and receive a completion token.",
      },
    ],
    [
      "POST /v1/pairing/complete",
      {
        access: "One-time completion token",
        purpose: "Accept a subset of the offered grants and activate the device.",
      },
    ],
    [
      "POST /v1/devices/wake-key",
      {
        access: "Encrypted live device bearer; managed bodies only",
        purpose:
          "Register this device’s public key for waking its hosted body. Self-hosted bodies return 404.",
      },
    ],
    [
      "POST /v1/discord/ingress",
      {
        purpose: "A trusted Discord connection delivers a sealed addressed turn",
        access: "Fleet-signed scoped permit and P-256 encrypted request and response",
      },
    ],
    [
      "POST /v1/hosted/operator",
      {
        access: "Encrypted live device bearer with account-paired operator authority",
        purpose:
          "Run a bounded operator request on the hosted body; device revocation and inner route validation remain authoritative.",
      },
    ],
    [
      "GET /v1/operator/fleet-settings",
      {
        access: "Encrypted live device bearer with terminalControl (Take Control)",
        purpose: "Read the owner's fleet size, models, work closure and machine setup responsibility.",
      },
    ],
    [
      "POST /v1/operator/fleet-settings",
      {
        access: "Encrypted live device bearer with terminalControl (Take Control)",
        purpose: "Update fleet settings against the current revision and owner authority.",
      },
    ],
    [
      "GET /v1/operator/projects",
      {
        access: "Encrypted live device bearer with terminalControl (Take Control)",
        purpose: "Read project settings, including autonomy overrides when explicitly requested.",
      },
    ],
    [
      "POST /v1/operator/projects/update",
      {
        access: "Encrypted live device bearer with terminalControl (Take Control)",
        purpose: "Update project settings and fleet responsibility overrides with current owner authority.",
      },
    ],
    [
      "POST /v1/hosted/pair-offer",
      {
        access: "Single-use fleet ticket bound to the browser key; managed bodies only",
        purpose: "Return a signed, encrypted pairing offer to the account page’s browser.",
      },
    ],
    [
      "POST /v1/hosted/support",
      {
        access: "Signed single-use hosted account ticket bound to the exact support command",
        purpose: "Apply an owner support command and return an authenticated encrypted response.",
      },
    ],
    [
      "GET /v1/support/grants",
      {
        access: "Owner operator or active device bearer with terminal-control access",
        purpose: "Read the body's customer-issued support grants and lifecycle state.",
      },
    ],
    [
      "POST /v1/support/grants",
      {
        access: "Owner operator or active device bearer with terminal-control access",
        purpose: "Create a referenced read-state or shell support window of at most 72 hours.",
      },
    ],
    [
      "GET /v1/devices/self",
      {
        access: "Device bearer",
        purpose: "Read the paired device’s own registration and grants.",
      },
    ],
    [
      "GET /v1/devices",
      {
        access: "Operator or paired device bearer",
        purpose: "List the owner's paired devices for Settings → Devices.",
      },
    ],
    [
      "POST /v1/devices/:id/revoke",
      {
        access: "Operator, or a paired device holding terminal control",
        purpose: "Revoke one paired device, including the caller itself.",
      },
    ],
    [
      "GET /v1/captain/readiness",
      {
        access: "Operator or paired device bearer",
        purpose: "Say whether Clankie can answer and, if not, the secret-free setup reason.",
      },
    ],
    [
      "GET /v1/devices/self/diagnostics-default",
      {
        access: "Operator or paired device bearer",
        purpose: "Read the account's diagnostics default the device inherits; no other settings.",
      },
    ],
    [
      "POST /v1/devices/self/session/refresh",
      {
        access: "Device bearer",
        purpose: "Renew the paired device’s short-lived session.",
      },
    ],
    [
      `POST ${DEVICE_PUSH_PATH}`,
      {
        access: "Device bearer",
        purpose: "Enable or disable this device’s versioned push reference on its machine.",
      },
    ],
    [
      "POST /v1/hooks/linear",
      {
        access: "Linear\u2019s own HMAC signature over the request body",
        purpose: "Wake the operator thread when the owner comments on a Linear issue.",
      },
    ],
    [
      "GET /v1/body-leases",
      {
        access: "Device bearer with terminal-observe access",
        purpose: "Read the active body leases and their ownership on the paired host.",
      },
    ],
    [
      "GET /v1/discord/rooms",
      {
        access: "Device bearer with terminal-observe access",
        purpose: "Read the Discord rooms and their routing state on the paired host.",
      },
    ],
    ...[
      ["GET", "status", "Read composer transcription availability and included recording allowance."],
      ["POST", "begin", "Begin a bounded, device-scoped composer recording."],
      ["POST", "chunk", "Append a bounded recording chunk at an exact byte offset."],
      ["POST", "commit", "Request one transcription for an editable draft; sending stays explicit."],
      ["POST", "cancel", "Discard that recording and prevent late draft delivery."],
      ["POST", "receipt", "Recover the same draft receipt without repeating provider dispatch."],
    ].map(([method, action, purpose]) => [
      `${method} /v1/composer/transcription/${action}`,
      { access: "Active ordinary paired device bearer with chat access; encrypted exchange only", purpose },
    ]),
    [
      "GET /v1/discord/settings",
      {
        access: "Device bearer with terminal-observe access",
        purpose: "Read the host's Discord settings without credentials.",
      },
    ],
    [
      "GET /v1/discord/directory",
      {
        access: "Device bearer with terminal-observe access",
        purpose: "Read the Discord guild and channel directory available to the host.",
      },
    ],
    [
      "GET /v1/discord/room-voice",
      {
        access: "Device bearer with terminal-observe access",
        purpose: "Read the selected Discord room's current voice state.",
      },
    ],
    [
      "GET /v1/discord/voice-transcripts",
      {
        access: "Device bearer with terminal-observe access",
        purpose: "Read bounded voice transcripts for the selected Discord room.",
      },
    ],
    [
      "POST /v1/discord/room-guidance",
      {
        access: "Device bearer with steer access",
        purpose: "Update owner guidance for a Discord room through its paired host.",
      },
    ],
    [
      "POST /v1/discord/setup/test-post",
      {
        access: "Device bearer with terminal-control access",
        purpose: "Send the bounded setup test message through the paired host's Discord body.",
      },
    ],
    [
      "POST /operator/v1/dispatch",
      {
        access: "Device bearer plus the operation’s grant",
        purpose: "Send a chat, fleet, steer, or terminal-control operation to Clankie’s host.",
      },
    ],
    [
      "POST /operator/v1/tail",
      {
        access: "Device bearer with chat access",
        purpose: "Read the app conversation as a bounded long-poll stream.",
      },
    ],
    [
      "POST /operator/v1/terminal-tail",
      {
        access: "Device bearer with terminal-observe access",
        purpose: "Read terminal frames from the host’s supported Herdr integration.",
      },
    ],
  ]);

  const rows = [
    {
      method: "GET",
      route: PUBLIC_GATEWAY_HEALTH_PATH,
      access: "Anonymous",
      purpose: "Deployment liveness only.",
    },
    {
      method: "GET",
      route: PUBLIC_GATEWAY_CONFIG_PATH,
      access: "Anonymous",
      purpose: "Publish the non-secret Cognito issuer, client id, and enrollment mode.",
    },
    {
      method: "WS",
      route: `${PUBLIC_GATEWAY_HOST_CONNECT_PATH}?hostId=…&installationId=…`,
      access: "Machine account bearer",
      purpose: "Keep one authenticated outbound connection from a Clankie machine.",
    },
    {
      method: "POST",
      route: PUBLIC_GATEWAY_PUSH_REGISTRATIONS_PATH,
      access: "Encrypted device proof verified by its machine, plus the app’s delivery key",
      purpose: "Register or move versioned APNs delivery when push is configured.",
    },
    {
      method: "POST",
      route: PUBLIC_GATEWAY_PUSH_CLEAR_PATH,
      access: "App delivery key; first allocation also requires an encrypted device proof",
      purpose: "Revoke delivery, including when the former machine is offline.",
    },
  ];

  for (const route of PUBLIC_GATEWAY_ROUTES) {
    const key = `${route.method} ${route.path}`;
    const detail = routeDetails.get(key);
    if (detail === undefined) throw new Error(`Public docs do not describe ${key}`);
    routeDetails.delete(key);
    rows.push({
      method: route.method,
      route: [
        "/v1/gateway/challenge",
        "/v1/gateway/encrypted",
        "/v1/gateway/push-authorize",
        "/v1/hooks/linear",
        "/v1/hosted/pair-offer",
        "/v1/discord/ingress",
        "/v1/activity/viewer",
      ].includes(route.path)
        ? `/h/{hostId}${route.path}`
        : `${route.path} (inside encrypted exchange)`,
      ...detail,
    });
  }

  if (routeDetails.size > 0) {
    throw new Error(`Public docs describe removed routes: ${[...routeDetails.keys()].join(", ")}`);
  }

  return { rows };
}

function networkRow({ method, route, access, purpose }) {
  return `
      <tr>
        <td><span class="method">${escapeHtml(method)}</span></td>
        <td><code>${escapeHtml(route)}</code></td>
        <td>${escapeHtml(access)}</td>
        <td>${escapeHtml(purpose)}</td>
      </tr>`;
}

// --- console -----------------------------------------------------------------

/**
 * The console registers every slash command as a `FaceShellCommand` literal
 * (`name`, `aliases`, `description`, optional `argumentHint`, `takesArgument`).
 * Read those literals straight from the source so the table cannot drift.
 * ponytail: regex over the literal shape, not a runtime import of the console;
 * the count check below fails the build when a command is registered in a
 * shape this cannot read.
 */
async function slashCommands() {
  const tuiSrc = resolve(repoRoot, "apps/tui/src");
  const literal =
    /name: "([^"]+)",\s*aliases: \[([^\]]*)\],\s*description: "([^"]*)",(?:\s*argumentHint:\s*"([^"]*)",)?\s*takesArgument: (?:true|false)/g;
  const commands = [];
  let registered = 0;
  for await (const file of glob("**/*.ts", { cwd: tuiSrc })) {
    const source = await readFile(resolve(tuiSrc, file), "utf8");
    // Hosted mode has a deliberately smaller command set, documented in the CLI
    // connection contract. Its duplicate /model, /persona, etc. are not local
    // console registrations. The shared connection picker is its sole addition.
    if (file === "hosted-console.ts") {
      registered += 1;
      commands.push({
        name: "connection",
        aliases: ["settings"],
        description: "Choose local or hosted Clankie",
        argument: "",
      });
      continue;
    }
    registered += (source.match(/^\s*takesArgument: (?:true|false),/gm) ?? []).length;
    for (const match of source.matchAll(literal)) {
      commands.push({
        name: match[1],
        aliases: [...match[2].matchAll(/"([^"]+)"/g)].map((alias) => alias[1]),
        description: match[3],
        argument: match[4] ?? "",
      });
    }
  }

  // `mediaModelCommand(name, role)` builds /image-model and /video-model from one
  // factory; its description and hint are templates, so they are described here.
  const provider = await readFile(resolve(tuiSrc, "provider-commands.ts"), "utf8");
  const factories = provider.match(/^function mediaModelCommand\(/gm)?.length ?? 0;
  const media = new Map([
    [
      "image-model",
      {
        description: "Choose the model Clankie makes pictures with",
        argument: "[openai|google|xai|status|unset]",
      },
    ],
    [
      "video-model",
      { description: "Choose the model Clankie makes video with", argument: "[xai|status|unset]" },
    ],
  ]);
  let mediaCount = 0;
  for (const match of provider.matchAll(/mediaModelCommand\("([a-z-]+)"/g)) {
    const detail = media.get(match[1]);
    if (detail === undefined) throw new Error(`Public docs do not describe the /${match[1]} console command`);
    media.delete(match[1]);
    commands.push({ name: match[1], aliases: [], ...detail });
    mediaCount += 1;
  }
  if (media.size > 0) {
    throw new Error(`Public docs describe removed console commands: ${[...media.keys()].join(", ")}`);
  }

  const literalCount = commands.length - mediaCount;
  if (registered !== literalCount + factories) {
    throw new Error(
      `The console registers ${registered} commands but the docs extractor read ${literalCount} literals and ${factories} factories; a command is registered in a shape build.mjs cannot read.`,
    );
  }

  slashCommandCount = commands.length;
  return commands.sort((a, b) => a.name.localeCompare(b.name));
}

async function consoleMarkdown() {
  const commands = await slashCommands();
  const cell = (text) => text.replaceAll("|", "\\|");
  const table = [
    "| Command | Aliases | Argument | What it does |",
    "| --- | --- | --- | --- |",
    ...commands.map(
      (command) =>
        `| \`/${command.name}\` | ${command.aliases.map((alias) => `\`/${alias}\``).join(", ")} | ${
          command.argument === "" ? "" : `\`${cell(command.argument)}\``
        } | ${cell(command.description)} |`,
    ),
  ].join("\n");

  const readme = (await readFile(resolve(repoRoot, "apps/tui/README.md"), "utf8")).replace(/\r\n?/gu, "\n");
  const section = (title) => {
    const start = readme.indexOf(`\n## ${title}\n`);
    if (start < 0) throw new Error(`apps/tui/README.md no longer has a "${title}" section`);
    const rest = readme.slice(start + 1);
    const end = rest.indexOf("\n## ", 1);
    const body = end < 0 ? rest : rest.slice(0, end);
    return absolutizeLinks(body.trim(), resolve(repoRoot, "apps/tui"));
  };

  const content = await readContent("console.md");
  // Function replacers: the README contains "$`", which a string replacer reads as a pattern.
  return content
    .replace("{{SLASH_COMMANDS}}", () => table)
    .replace("{{TUI_README_WORKSPACES}}", () => section("Workspaces"))
    .replace("{{TUI_README_OPERATOR_BEHAVIOR}}", () => section("Operator behavior"));
}

// --- HTTP API ----------------------------------------------------------------

const METHODS = ["get", "post", "put", "patch", "delete"];

async function apiMarkdown() {
  const spec = parseYaml(await readFile(resolve(repoRoot, "apps/clankie/openapi.yaml"), "utf8"));
  const schemes = spec.components?.securitySchemes ?? {};
  const schemeLabel = (key) =>
    key
      .replace(/Bearer$/, "")
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .toLowerCase();
  const bearers = (security) => {
    const list = security ?? spec.security ?? [];
    if (list.length === 0) return "none";
    return list.map((entry) => schemeLabel(Object.keys(entry)[0])).join(" or ");
  };
  const resolveRef = (parameter) =>
    parameter.$ref === undefined
      ? parameter
      : spec.components.parameters[parameter.$ref.replace("#/components/parameters/", "")];

  const operations = [];
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const method of METHODS) {
      const operation = item[method];
      if (operation === undefined) continue;
      operations.push({ method: method.toUpperCase(), path, ...operation });
    }
  }
  apiOperationCount = operations.length;

  const heading = (operation) => `${operation.method} ${operation.path} — ${operation.summary}`;
  const lines = [
    "# HTTP API",
    "",
    spec.info.description.trim(),
    "",
    `Base URL \`${spec.servers[0].url}\` · version ${spec.info.version} · the raw document is [openapi.yaml](/api/openapi.yaml).`,
    "",
    "> This is the service contract on Clankie’s host. The [public network surface](/network/) exposes a bounded subset through `api.clankie.bot`; the host still decides every device grant. Hosted account and billing endpoints are separate contracts.",
    "",
    "## Bearers",
    "",
    "| Bearer | Where it lives |",
    "| --- | --- |",
    ...Object.entries(schemes).map(([key, scheme]) => `| ${schemeLabel(key)} | ${scheme.description} |`),
    "",
    "## Routes",
    "",
    "| Method | Route | Summary | Bearer |",
    "| --- | --- | --- | --- |",
    ...operations.map(
      (operation) =>
        `| ${operation.method} | [\`${operation.path}\`](#${slug(heading(operation))}) | ${operation.summary} | ${bearers(operation.security)} |`,
    ),
  ];

  for (const tag of spec.tags) {
    const group = operations.filter((operation) => operation.tags[0] === tag.name);
    if (group.length === 0) continue;
    lines.push("", `## ${tag.name}`);
    for (const operation of group) {
      lines.push("", `### \`${operation.method} ${operation.path}\` — ${operation.summary}`, "");
      if (operation.description) lines.push(operation.description.trim(), "");
      lines.push(`**Bearer:** ${bearers(operation.security)}`);
      const parameters = (operation.parameters ?? []).map(resolveRef);
      if (parameters.length > 0) {
        lines.push(
          "",
          "| In | Name | Required | Type | Description |",
          "| --- | --- | --- | --- | --- |",
          ...parameters.map(
            (parameter) =>
              `| ${parameter.in} | \`${parameter.name}\` | ${parameter.required ? "yes" : "no"} | ${schemaSummary(
                parameter.schema,
              )} | ${parameter.description ?? ""} |`,
          ),
        );
      }
      const body = operation.requestBody?.content?.["application/json"];
      if (body !== undefined) {
        lines.push("", `**Request body** (${operation.requestBody.required ? "required" : "optional"} JSON)`);
        if (body.example !== undefined) {
          lines.push("", "```json", JSON.stringify(body.example, null, 2), "```");
        } else if (body.examples !== undefined) {
          for (const [name, example] of Object.entries(body.examples)) {
            lines.push(
              "",
              `*${example.summary ?? name}*`,
              "",
              "```json",
              JSON.stringify(example.value, null, 2),
              "```",
            );
          }
        } else if (body.schema !== undefined) {
          lines.push("", `A JSON ${body.schema.type ?? "value"}.`);
        }
      }
      lines.push(
        "",
        "| Status | Meaning |",
        "| --- | --- |",
        ...Object.entries(operation.responses).map(([status, response]) => {
          const type = Object.keys(response.content ?? {})[0];
          return `| ${status} | ${response.description}${type === undefined ? "" : ` (\`${type}\`)`} |`;
        }),
      );
    }
  }
  return lines.join("\n");
}

function schemaSummary(schema) {
  if (schema === undefined) return "";
  const parts = [schema.type ?? "value"];
  if (schema.enum) parts.push(`one of ${schema.enum.map((value) => `\`${value}\``).join(", ")}`);
  if (schema.minimum !== undefined || schema.maximum !== undefined) {
    parts.push(`${schema.minimum ?? "…"}–${schema.maximum ?? "…"}`);
  }
  if (schema.default !== undefined) parts.push(`default ${schema.default}`);
  if (schema.pattern) parts.push(`matching \`${schema.pattern}\``);
  if (schema.example !== undefined) parts.push(`e.g. \`${schema.example}\``);
  return parts.join(", ");
}

// --- markdown ----------------------------------------------------------------

// Static pages stay canonical too: Markdown permits their semantic HTML.
// Export only the main content, with absolute links, without duplicating prose.
async function staticPageContent(path) {
  const html = await readFile(path, "utf8");
  const main = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/)?.[1];
  if (main === undefined) throw new Error(`${path} has no main content`);
  return main.trim().replace(/\b(href|src)="\/(?!\/)/g, `$1="${SITE}/`);
}

async function readContent(name) {
  return absolutizeLinks(await readFile(resolve(contentDir, name), "utf8"), contentDir);
}

/** Rewrite links relative to `sourceDir` as GitHub links so rendered docs and llms-full.txt resolve from anywhere. */
function absolutizeLinks(markdown, sourceDir) {
  return markdown.replace(/\]\(([^)\s]+)((?:\s+"[^"]*")?)\)/g, (match, target, title) => {
    if (/^(?:https?:|mailto:|#|\/)/u.test(target)) return match;
    const [file, fragment] = target.split("#", 2);
    const path = relative(repoRoot, resolve(sourceDir, decodeURIComponent(file)))
      .split(sep)
      .join("/");
    return `](${REPO_BLOB}/${path}${fragment === undefined ? "" : `#${fragment}`}${title})`;
  });
}

function renderMarkdown(markdown) {
  let html = marked.parse(markdown);
  const used = new Set();
  const headings = [];
  html = html.replace(/<h([1-6])>([\s\S]*?)<\/h\1>/g, (match, level, inner) => {
    let id = slug(inner);
    for (let n = 2; used.has(id); n += 1) id = `${slug(inner)}-${n}`;
    used.add(id);
    if (level === "2") headings.push({ id, inner });
    return `<h${level} id="${id}">${inner}</h${level}>`;
  });
  html = html
    .replaceAll("<table>", '<div class="table-wrap"><table>')
    .replaceAll("</table>", "</table></div>");
  if (headings.length >= 5) {
    const toc = `<nav class="toc" aria-label="On this page"><ul>${headings
      .map((heading) => `<li><a href="#${heading.id}">${heading.inner}</a></li>`)
      .join("")}</ul></nav>`;
    html = html.replace("</h1>", () => `</h1>${toc}`);
  }
  return html;
}

function slug(text) {
  return text
    .replace(/<[^>]+>/g, "")
    .replace(/&#(\d+);/g, (match, code) => String.fromCharCode(Number(code)))
    .replace(/&(amp|lt|gt|quot);/g, (match, name) => ({ amp: "&", lt: "<", gt: ">", quot: '"' })[name])
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

// --- site chrome -------------------------------------------------------------

function navHtml(currentPath) {
  return NAV.map(({ href, label, optional, narrow }) => {
    const classes = [optional && "optional", narrow && "narrow"].filter(Boolean);
    const current = href === currentPath ? ' aria-current="page"' : "";
    return `<a${classes.length ? ` class="${classes.join(" ")}"` : ""}${current} href="${href}">${label}</a>`;
  }).join("\n          ");
}

async function fillMarker(path, marker, value) {
  const source = await readFile(path, "utf8");
  if (!source.includes(marker)) throw new Error(`${relative(repoRoot, path)} is missing ${marker}`);
  await writeFile(
    path,
    source.replaceAll(marker, () => value),
  );
}

function sitemap() {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...PAGES.map((page) => `  <url><loc>${SITE}${page.path}</loc></url>`),
    "</urlset>",
    "",
  ].join("\n");
}

function llmsIndex() {
  return [
    "# Clankie",
    "",
    "> Clankie is a persistent personal assistant with a personality, memory, and tools for everyday help, creative projects, and work with helper agents. He can run on a managed private machine or a machine you maintain. The iPhone and iPad app reaches that service. The open-source DIY setup adds configurable models, skills, coding harnesses, Discord, voice, and play; capabilities depend on the host and connected services.",
    "",
    "The service (`apps/clankie`, HTTP on `127.0.0.1:4310` on its host) owns conversations, goals, memory, tools, and access. Clankie's built-in runtime is pi. Native harness channels carry agent messages; Herdr supplies the worker terminals. The CLI, API, and MCP projection serve technical users. The CLI reference documents JSON output and its exceptions. Hosted plans and availability live on clankie.bot; this library does not infer shipping support from a source-code capability.",
    "",
    "## Docs",
    "",
    ...PAGES.map((page) => `- [${page.title}](${SITE}${page.path}): ${page.description}`),
    `- [OpenAPI document](${SITE}/api/openapi.yaml): the raw local service catalog`,
    `- [Everything on one page](${SITE}/llms-full.txt): the pages above plus the repository architecture document, as Markdown`,
    "",
    "## Source",
    "",
    `- [Repository](${REPO}): Apache-2.0, except the AGPL native Discord media process`,
    `- [Architecture](${REPO_BLOB}/docs/architecture.md): the system shape and where things run`,
    `- [Decision records](${REPO_BLOB}/docs/adr): why each boundary is where it is`,
    `- [Agent instructions](${REPO_BLOB}/AGENTS.md): read before pointing a coding agent at the repository`,
    "",
    "## Product",
    "",
    "- [Home](https://clankie.bot)",
    "- [Privacy](https://clankie.bot/privacy/)",
    "- [Support](https://clankie.bot/support/)",
    "",
  ].join("\n");
}

function llmsFull(documents) {
  const header = `# Clankie documentation\n\nGenerated from ${SITE}. Each section below is one page or one repository document; relative links have been rewritten to the repository.`;
  return `${[header, ...documents.map((document) => document.trim().replaceAll("](/", `](${SITE}/`))].join("\n\n---\n\n")}\n`;
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

if (import.meta.main) await buildPublicDocs();
