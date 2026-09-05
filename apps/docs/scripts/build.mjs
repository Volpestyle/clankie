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
  { href: "/#start", label: "Start" },
  { href: "/#app", label: "App" },
  { href: "/how-it-works/", label: "How he works", optional: true },
  { href: "/console/", label: "Console", optional: true },
  { href: "/cli/", label: "CLI", optional: true },
  { href: "/api/", label: "API", optional: true },
  { href: "/network/", label: "Network", optional: true },
  { href: "/#reference", label: "Reference", narrow: true },
  { href: "https://clankie.bot/support/", label: "Support" },
];

/** Every page the site publishes, in sitemap and llms.txt order. */
const PAGES = [
  {
    path: "/",
    title: "Start",
    description: "Install Clankie on your machine, give him a model, reach him from your phone.",
  },
  {
    path: "/how-it-works/",
    title: "How he works",
    description:
      "One service on your machine, the rooms he lives in, how a message becomes a turn, and what stays where.",
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
    "/how-it-works/": await readContent("how-it-works.md"),
    "/console/": await consoleMarkdown(),
    "/cli/": absolutizeLinks(
      await readFile(resolve(repoRoot, "docs/cli.md"), "utf8"),
      resolve(repoRoot, "docs"),
    ),
    "/api/": await apiMarkdown(),
    "/network/": network.markdown,
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
      "POST /v1/pairing/redeem",
      {
        access: "One-time offer secret or typed code",
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
      "GET /v1/devices/self",
      {
        access: "Device bearer",
        purpose: "Read the paired device’s own registration and grants.",
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
      "POST /operator/v1/dispatch",
      {
        access: "Device bearer plus the operation’s grant",
        purpose: "Send a chat, fleet, steer, or terminal-control operation to your machine.",
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
        purpose: "Read terminal frames from your machine’s supported Herdr integration.",
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
      access: "Device bearer verified by its machine, plus the app’s delivery key",
      purpose: "Register or move versioned APNs delivery when push is configured.",
    },
    {
      method: "POST",
      route: PUBLIC_GATEWAY_PUSH_CLEAR_PATH,
      access: "App delivery key; first allocation also requires a verified device bearer",
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
      route: route.path === "/v1/pairing/redeem" ? route.path : `/h/{hostId}${route.path}`,
      ...detail,
    });
  }

  if (routeDetails.size > 0) {
    throw new Error(`Public docs describe removed routes: ${[...routeDetails.keys()].join(", ")}`);
  }

  const markdown = [
    "# Public network surface",
    "",
    "`api.clankie.bot` accepts only the routes below. The gateway carries bounded exchanges to an authenticated machine; your machine still owns devices, grants, conversations, and terminal authority. It does not run Clankie, a model, a terminal, or a Herdr fleet, and it retains no forwarded content bodies, message content, or terminal frames.",
    "",
    "```",
    "iPhone or iPad ── HTTPS ── api.clankie.bot ── outbound WebSocket ── your machine",
    "```",
    "",
    "The first pairing redemption uses the stable public origin. Successful redemption returns an opaque, host-scoped origin (`/h/{hostId}`). Normal app calls use that origin and a device credential minted by your machine.",
    "",
    "When push is configured, the gateway stores APNs tokens, routing identifiers, delivery-key hashes and versioned revocations. Only the app’s key can move or clear an existing delivery registration. Wakes contain a fixed alert and host/conversation identifiers, never message text. Apple receives the token, timing and those identifiers. An unconfigured gateway refuses push without changing pairing or messaging.",
    "",
    "| Method | Route | Access | Purpose |",
    "| --- | --- | --- | --- |",
    ...rows.map((row) => `| ${row.method} | \`${row.route}\` | ${row.access} | ${row.purpose} |`),
    "",
    "These routes are the product’s observable internet boundary, not a general third-party API. Clients pair through Clankie and use credentials and grants issued by the user’s machine. The full local contract is the [HTTP API](/api/).",
  ].join("\n");

  return { rows, markdown };
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
    /name: "([^"]+)",\s*aliases: \[([^\]]*)\],\s*description: "([^"]*)",(?:\s*argumentHint: "([^"]*)",)?\s*takesArgument: (?:true|false)/g;
  const commands = [];
  let registered = 0;
  for await (const file of glob("**/*.ts", { cwd: tuiSrc })) {
    const source = await readFile(resolve(tuiSrc, file), "utf8");
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

  const readme = await readFile(resolve(repoRoot, "apps/tui/README.md"), "utf8");
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
    "> This is the local contract on your machine. From the internet only the [public network surface](/network/) is reachable, through `api.clankie.bot`, and your machine still decides every grant.",
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
    "> A persistent agent with a life of his own. Clankie runs on your machine, an Apple-silicon Mac: he chats in Discord (text and voice), plays Pokémon live on a watch surface, makes images and videos, browses the web, remembers people, codes, and leads a fleet of coding agents through herdr panes. Your machine is authoritative; nothing of his runs in the cloud. An iPhone and iPad app reaches your machine through a narrow public gateway (`api.clankie.bot`) and does not require Tailscale.",
    "",
    "He is one local service (`apps/clankie`, HTTP on `127.0.0.1:4310`) plus the surfaces that reach it: the operator console (TUI), the companion app, one active Discord body, a Claude Code seat, and a macOS menu bar. The captain is a pi-based agent with durable sessions per room; persona is owner-authored; model output and Discord content are untrusted input. `clankie <noun> <verb>` is the headless control layer and prints one JSON document per command.",
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
