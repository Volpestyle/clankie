import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  PUBLIC_GATEWAY_CONFIG_PATH,
  PUBLIC_GATEWAY_HEALTH_PATH,
  PUBLIC_GATEWAY_HOST_CONNECT_PATH,
  PUBLIC_GATEWAY_ROUTES,
} from "../../../packages/protocol/src/public-gateway.ts";

const appRoot = resolve(import.meta.dirname, "..");
const repoRoot = resolve(appRoot, "../..");
const sourceDir = resolve(appRoot, "site");
const defaultOutputDir = resolve(appRoot, "dist");

export async function buildPublicDocs(outputDir = defaultOutputDir) {
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
      "POST /operator/v1/dispatch",
      {
        access: "Device bearer plus the operation’s grant",
        purpose: "Send a chat, fleet, steer, or terminal-control operation to the Mac.",
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
        purpose: "Read terminal frames from the Mac’s supported Herdr integration.",
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
      access: "Mac account bearer",
      purpose: "Keep one authenticated outbound connection from a Clankie Mac.",
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

  const table = rows
    .map(
      ({ method, route, access, purpose }) => `
      <tr>
        <td><span class="method">${escapeHtml(method)}</span></td>
        <td><code>${escapeHtml(route)}</code></td>
        <td>${escapeHtml(access)}</td>
        <td>${escapeHtml(purpose)}</td>
      </tr>`,
    )
    .join("");

  await rm(outputDir, { recursive: true, force: true });
  await cp(sourceDir, outputDir, { recursive: true });
  await mkdir(resolve(outputDir, "assets"), { recursive: true });
  await cp(
    resolve(repoRoot, "branding/clankie-logo-512-alpha.png"),
    resolve(outputDir, "assets/clankie.png"),
  );

  const networkPath = resolve(outputDir, "network/index.html");
  const network = await readFile(networkPath, "utf8");
  const marker = "{{PUBLIC_GATEWAY_TABLE}}";
  if (!network.includes(marker)) throw new Error("Public gateway table marker is missing");
  await writeFile(networkPath, network.replace(marker, table));

  console.log(`Built public docs with ${rows.length} documented network routes.`);
}

if (import.meta.main) await buildPublicDocs();

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
