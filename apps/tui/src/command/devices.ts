import { resolveOperatorCredential, type CredentialStore } from "@clankie/credential-broker";
import {
  DevicesCommandError,
  devicesFailureMessage,
  grantSummary,
  listDevices,
  revokeDevice,
  type DeviceListItem,
} from "../../bin/devices.ts";
import { commandHost, outputJson, type Writable } from "./io.ts";

const DEVICES_USAGE = "Usage: clankie devices [--json] | clankie devices revoke <id> [--json]";
const DEFAULT_DEVICES_TIMEOUT_MS = 10_000;

export interface DevicesCliCommandOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly host?: string;
  readonly fetchImpl?: typeof fetch;
  readonly operatorCredentialStore?: CredentialStore;
  readonly stdout?: Writable;
  readonly stderr?: Writable;
}

type DevicesCliOptions =
  | { readonly json: boolean; readonly subcommand: "list" }
  | { readonly json: boolean; readonly subcommand: "revoke"; readonly deviceId: string };

function parseDevicesArgs(args: readonly string[]): DevicesCliOptions {
  let json = false;
  const positional: string[] = [];
  for (const arg of args) {
    if (arg === "--json") {
      json = true;
      continue;
    }
    positional.push(arg);
  }
  if (positional.length === 0) return { json, subcommand: "list" };
  if (positional[0] === "revoke") {
    const deviceId = positional[1];
    if (deviceId === undefined || positional.length > 2) throw new Error(DEVICES_USAGE);
    return { json, subcommand: "revoke", deviceId };
  }
  throw new Error(DEVICES_USAGE);
}

function formatDevicesTable(devices: readonly DeviceListItem[]): string {
  if (devices.length === 0) return "No paired devices.";
  const header = ["DEVICE", "NAME", "PLATFORM", "STATUS", "SOURCE", "GRANTS", "PAIRED"] as const;
  const rows = devices.map((device) => [
    device.deviceId,
    device.name,
    device.platform,
    device.status,
    device.review === true ? "review" : "pair",
    grantSummary(device),
    device.activatedAt ?? device.createdAt,
  ]);
  const widths = header.map((label, column) =>
    Math.max(label.length, ...rows.map((row) => (row[column] ?? "").length)),
  );
  const renderRow = (cells: readonly string[]): string =>
    cells
      .map((cell, column) => cell.padEnd(widths[column] ?? 0))
      .join("  ")
      .trimEnd();
  return [renderRow(header), ...rows.map(renderRow)].join("\n");
}

export async function runDevicesCommand(
  args: readonly string[],
  options: DevicesCliCommandOptions,
): Promise<number> {
  const parsed = parseDevicesArgs(args);
  const env = options.env ?? process.env;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const controlPlaneUrl = commandHost({ ...options, env });
  const operatorCredential = await resolveOperatorCredential({
    env,
    ...(options.operatorCredentialStore === undefined ? {} : { store: options.operatorCredentialStore }),
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_DEVICES_TIMEOUT_MS);
  const request = {
    controlPlaneUrl,
    operatorToken: operatorCredential?.token,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    signal: controller.signal,
  };
  try {
    if (parsed.subcommand === "revoke") {
      const device = await revokeDevice(parsed.deviceId, request);
      if (parsed.json) outputJson(stdout, { ok: true, device });
      else stdout.write(`Revoked ${device.deviceId} (${device.name}).\n`);
      return 0;
    }
    const devices = await listDevices(request);
    if (parsed.json) outputJson(stdout, { ok: true, devices });
    else stdout.write(`${formatDevicesTable(devices)}\n`);
    return 0;
  } catch (error) {
    const status = error instanceof DevicesCommandError ? error.status : "unavailable";
    const message =
      error instanceof DevicesCommandError ? error.message : devicesFailureMessage("unavailable");
    if (parsed.json) outputJson(stdout, { ok: false, status, error: message });
    else stderr.write(`clankie: ${message}\n`);
    return 1;
  } finally {
    clearTimeout(timer);
  }
}
