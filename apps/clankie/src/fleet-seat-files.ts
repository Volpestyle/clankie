import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONNECTOR_IMAGE_READ_BYTES_MAX, type SeatImageResult } from "@clankie/protocol/connector";
import type { StoredOwnerAttachment } from "./delivered-files.ts";
import {
  SSH_BASE_OPTIONS,
  posixQuote,
  posixScriptCommand,
  powershellLiteral,
  powershellScriptCommand,
  type FleetShellRun,
  type HerdrFleet,
} from "./herdr-fleet.ts";
import { materializeOwnerAttachments } from "./owner-attachments.ts";
import { seatImageFromBytes, seatImageTooLarge } from "./seat-images.ts";

/**
 * Files to and from a seat on a linked machine (ADR 0316). Attachments are
 * prepared on this Mac exactly as for a local seat (ADR 0209), copied with scp
 * to a staging folder in the remote account's home, then moved into the
 * seat's `.clankie/inbox/<message>/` by a command that checks the workspace
 * there. An image is read back by a command that checks containment and size
 * on that machine and prints the bytes as base64; this Mac checks they are an
 * image. Nothing travels inside a command line, so cmd.exe's limit never
 * applies.
 */

const STAGING = ".clankie/attachment-staging";
const OK = "clankie-ok";
const REFUSED = "clankie-refused";
const LARGE = "clankie-large";
const IMAGE = "clankie-image";
const GITIGNORE_LINE = "# Owner attachments delivered by Clankie; never commit them.";
const OUTSIDE =
  "Only files inside the agent's working directory can be read. Ask the agent to save the image there, for example in .clankie/inbox/, which git ignores.";
const NO_WORKSPACE = "The agent's working directory isn't on that machine.";
const INBOX_REFUSED =
  "The agent's .clankie inbox on that machine isn't a plain folder, so nothing was placed there.";

/** Copies a local directory to a path relative to the remote account's home. */
export type FleetCopy = (source: string, destination: string) => Promise<void>;

function scpCopy(fleet: HerdrFleet): FleetCopy {
  return (source, destination) =>
    new Promise<void>((resolve, reject) =>
      execFile(
        "scp",
        [
          ...SSH_BASE_OPTIONS.filter((option) => option !== "-T"),
          "-q",
          "-r",
          source,
          `${fleet.ssh.host}:${destination}`,
        ],
        { timeout: 300_000 },
        (error, _stdout, stderr) =>
          error === null
            ? resolve()
            : reject(new Error(`copying to ${fleet.id} failed: ${String(stderr).trim() || error.message}`)),
      ),
    );
}

/** The last line of a command's output, split on its first tab. */
function answer(stdout: string): { tag: string; rest: string } {
  const line = stdout.trimEnd().split(/\r?\n/u).at(-1) ?? "";
  const tab = line.indexOf("\t");
  return tab < 0 ? { tag: line, rest: "" } : { tag: line.slice(0, tab), rest: line.slice(tab + 1) };
}

/** A name every filesystem the fleet may run takes, Windows included. */
function portableName(name: string): string {
  const cleaned = name
    .replace(/[<>:"|?*\\/\p{Cc}]/gu, "_")
    .replace(/[. ]+$/u, "")
    .slice(0, 160);
  const safe = cleaned.length === 0 ? "attachment" : cleaned;
  return /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/iu.test(safe) ? `_${safe}` : safe;
}

/**
 * A PowerShell body run as one function, so every answer is its return value
 * on the pipeline: no `exit` inside a script block, and no direct console
 * writes that a resident host could reserve.
 */
function powershellScript(body: readonly string[]): string {
  return powershellScriptCommand(
    ["$ErrorActionPreference = 'Stop'", "function Main {", ...body, "}", "Main"].join("\n"),
  );
}

function stageCommand(fleet: HerdrFleet, workspace: string, messageId: string): string {
  return fleet.ssh.shell === "powershell"
    ? powershellScript([
        `if (-not (Test-Path -LiteralPath ${powershellLiteral(workspace)} -PathType Container)) { return '${REFUSED}' + [char]9 + ${powershellLiteral(NO_WORKSPACE)} }`,
        `$parent = Join-Path $env:USERPROFILE ${powershellLiteral(STAGING.replaceAll("/", "\\"))}`,
        "New-Item -ItemType Directory -Force -Path $parent | Out-Null",
        `$stage = Join-Path $parent ${powershellLiteral(messageId)}`,
        "if (Test-Path -LiteralPath $stage) { Remove-Item -Recurse -Force -LiteralPath $stage }",
        `return '${OK}'`,
      ])
    : posixScriptCommand(
        [
          `[ -d ${posixQuote(workspace)} ] || { printf '${REFUSED}\\t%s\\n' ${posixQuote(NO_WORKSPACE)}; exit 0; }`,
          `mkdir -p "$HOME/${STAGING}"`,
          `rm -rf "$HOME/${STAGING}/${messageId}"`,
          `printf '${OK}\\n'`,
        ].join("\n"),
      );
}

function placeCommand(fleet: HerdrFleet, workspace: string, messageId: string): string {
  if (fleet.ssh.shell === "powershell")
    return powershellScript([
      `$stage = Join-Path (Join-Path $env:USERPROFILE ${powershellLiteral(STAGING.replaceAll("/", "\\"))}) ${powershellLiteral(messageId)}`,
      `function Refuse($why) { if (Test-Path -LiteralPath $stage) { Remove-Item -Recurse -Force -LiteralPath $stage }; return '${REFUSED}' + [char]9 + $why }`,
      "try {",
      `$ws = ${powershellLiteral(workspace)}`,
      `if (-not (Test-Path -LiteralPath $ws -PathType Container)) { return Refuse ${powershellLiteral(NO_WORKSPACE)} }`,
      "$root = (Get-Item -LiteralPath $ws -Force).FullName.TrimEnd('\\')",
      "foreach ($dir in @((Join-Path $root '.clankie'), (Join-Path $root '.clankie\\inbox'))) {",
      "if (Test-Path -LiteralPath $dir) {",
      "$item = Get-Item -LiteralPath $dir -Force",
      `if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { return Refuse ${powershellLiteral(INBOX_REFUSED)} }`,
      "} else { New-Item -ItemType Directory -Path $dir | Out-Null }",
      "}",
      "$inbox = Join-Path $root '.clankie\\inbox'",
      "$ignore = Join-Path $inbox '.gitignore'",
      `if ((Test-Path -LiteralPath $ignore) -and (((Get-Item -LiteralPath $ignore -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -or (Test-Path -LiteralPath $ignore -PathType Container))) { return Refuse ${powershellLiteral(INBOX_REFUSED)} }`,
      `[IO.File]::WriteAllText($ignore, ${powershellLiteral(GITIGNORE_LINE)} + [char]10 + '*' + [char]10, (New-Object Text.UTF8Encoding $false))`,
      `$target = Join-Path $inbox ${powershellLiteral(messageId)}`,
      `if (Test-Path -LiteralPath $target) { return Refuse ${powershellLiteral(INBOX_REFUSED)} }`,
      // Staging is in the home folder; the workspace may be on another drive.
      "Copy-Item -LiteralPath $stage -Destination $target -Recurse",
      "Remove-Item -Recurse -Force -LiteralPath $stage",
      `return '${OK}' + [char]9 + $target`,
      "} catch { return Refuse ('The files could not be placed on that machine: ' + $_.Exception.Message) }",
    ]);
  return posixScriptCommand(
    [
      `stage="$HOME/${STAGING}/${messageId}"`,
      `refuse() { rm -rf "$stage"; printf '${REFUSED}\\t%s\\n' "$1"; exit 0; }`,
      `ws=${posixQuote(workspace)}`,
      `[ -d "$ws" ] || refuse ${posixQuote(NO_WORKSPACE)}`,
      `root=$(cd "$ws" && pwd -P) || refuse ${posixQuote(NO_WORKSPACE)}`,
      'for dir in "$root/.clankie" "$root/.clankie/inbox"; do',
      `  if [ -L "$dir" ] || { [ -e "$dir" ] && [ ! -d "$dir" ]; }; then refuse ${posixQuote(INBOX_REFUSED)}; fi`,
      `  [ -d "$dir" ] || mkdir -m 700 "$dir" || refuse ${posixQuote(INBOX_REFUSED)}`,
      "done",
      'inbox="$root/.clankie/inbox"',
      `if [ -L "$inbox/.gitignore" ] || { [ -e "$inbox/.gitignore" ] && [ ! -f "$inbox/.gitignore" ]; }; then refuse ${posixQuote(INBOX_REFUSED)}; fi`,
      `printf '%s\\n*\\n' ${posixQuote(GITIGNORE_LINE)} > "$inbox/.gitignore" || refuse ${posixQuote(INBOX_REFUSED)}`,
      `target="$inbox/${messageId}"`,
      `[ -e "$target" ] && refuse ${posixQuote(INBOX_REFUSED)}`,
      `mv "$stage" "$target" || refuse ${posixQuote(INBOX_REFUSED)}`,
      `printf '${OK}\\t%s\\n' "$target"`,
    ].join("\n"),
  );
}

/**
 * Owner attachments into a seat on a linked machine, prepared here as for a
 * local seat (HEIC JPEG copies and video keyframes included), with the note
 * naming the paths on that machine.
 */
export async function deliverToFleetSeat(input: {
  readonly fleet: HerdrFleet;
  readonly shell: FleetShellRun;
  readonly copy?: FleetCopy;
  readonly workspace: string;
  readonly messageId: string;
  readonly attachments: readonly StoredOwnerAttachment[];
}): Promise<{ readonly directory: string; readonly note: string } | { readonly undeliverable: string }> {
  const scratch = await mkdtemp(join(tmpdir(), "clankie-fleet-attachments-"));
  try {
    const prepared = await materializeOwnerAttachments({
      workspace: scratch,
      messageId: input.messageId,
      attachments: input.attachments.map((attachment) => ({
        ...attachment,
        file: { ...attachment.file, filename: portableName(attachment.file.filename) },
      })),
    });
    const staged = answer(
      await input.shell(stageCommand(input.fleet, input.workspace, input.messageId), 30_000),
    );
    if (staged.tag === REFUSED) return { undeliverable: staged.rest };
    if (staged.tag !== OK) return { undeliverable: `${input.fleet.id} didn't answer the file handoff.` };
    await (input.copy ?? scpCopy(input.fleet))(prepared.directory, `${STAGING}/${input.messageId}`);
    const placed = answer(
      await input.shell(placeCommand(input.fleet, input.workspace, input.messageId), 120_000),
    );
    if (placed.tag !== OK || placed.rest === "")
      return {
        undeliverable: placed.tag === REFUSED ? placed.rest : `${input.fleet.id} didn't place the files.`,
      };
    const windows = input.fleet.ssh.shell === "powershell";
    const local = prepared.directory;
    const note = prepared.note
      .split("\n")
      .map((line) => {
        const at = line.indexOf(local);
        if (at < 0) return line;
        const tail = line.slice(at + local.length);
        return `${line.slice(0, at)}${placed.rest}${windows ? tail.replaceAll("/", "\\") : tail}`;
      })
      .join("\n");
    return { directory: placed.rest, note };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

function readCommand(fleet: HerdrFleet, workspace: string, path: string): string {
  if (fleet.ssh.shell === "powershell")
    return powershellScript([
      `function Refuse($why) { return '${REFUSED}' + [char]9 + $why }`,
      `$ws = ${powershellLiteral(workspace)}`,
      `$rel = ${powershellLiteral(path)}`,
      `if (-not (Test-Path -LiteralPath $ws -PathType Container)) { return Refuse ${powershellLiteral(NO_WORKSPACE)} }`,
      "$root = (Get-Item -LiteralPath $ws -Force).FullName.TrimEnd('\\')",
      "if ([IO.Path]::IsPathRooted($rel)) { $joined = $rel } else { $joined = Join-Path $root $rel }",
      "$full = [IO.Path]::GetFullPath($joined)",
      `if (-not $full.StartsWith($root + '\\', [StringComparison]::OrdinalIgnoreCase)) { return Refuse ${powershellLiteral(OUTSIDE)} }`,
      `if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { return Refuse ${powershellLiteral(`There's no file at ${path} in the agent's working directory.`)} }`,
      // No junction or symlink between the workspace and the file.
      "$step = $full",
      "while ($step.Length -gt $root.Length) {",
      `if ((Get-Item -LiteralPath $step -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { return Refuse ${powershellLiteral(OUTSIDE)} }`,
      "$step = [IO.Path]::GetDirectoryName($step)",
      "}",
      "$file = Get-Item -LiteralPath $full -Force",
      `if ($file.Length -gt ${String(CONNECTOR_IMAGE_READ_BYTES_MAX)}) { return '${LARGE}' + [char]9 + $file.Length }`,
      `return '${IMAGE}' + [char]9 + $file.Name + [char]9 + [Convert]::ToBase64String([IO.File]::ReadAllBytes($full))`,
    ]);
  return posixScriptCommand(
    [
      `refuse() { printf '${REFUSED}\\t%s\\n' "$1"; exit 0; }`,
      `ws=${posixQuote(workspace)}`,
      `rel=${posixQuote(path)}`,
      `[ -d "$ws" ] || refuse ${posixQuote(NO_WORKSPACE)}`,
      `root=$(cd "$ws" && pwd -P) || refuse ${posixQuote(NO_WORKSPACE)}`,
      'case "$rel" in /*) asked="$rel" ;; *) asked="$root/$rel" ;; esac',
      // Resolve the folder physically and read through it, so `link/../x` can't leave.
      `dir=$(cd -P "$(dirname "$asked")" 2>/dev/null && pwd -P) || refuse ${posixQuote(`There's no file at ${path} in the agent's working directory.`)}`,
      `case "$dir/" in "$root"/*) ;; *) refuse ${posixQuote(OUTSIDE)} ;; esac`,
      'file="$dir/$(basename "$asked")"',
      `[ -L "$file" ] && refuse ${posixQuote(OUTSIDE)}`,
      `[ -f "$file" ] || refuse ${posixQuote(`There's no file at ${path} in the agent's working directory.`)}`,
      `size=$(wc -c < "$file" | tr -d ' ')`,
      `if [ "$size" -gt ${String(CONNECTOR_IMAGE_READ_BYTES_MAX)} ]; then printf '${LARGE}\\t%s\\n' "$size"; exit 0; fi`,
      `printf '${IMAGE}\\t%s\\t' "$(basename "$file")"`,
      `base64 < "$file" | tr -d '\\n'`,
      "printf '\\n'",
    ].join("\n"),
  );
}

/** One image a seat on a linked machine saved in its workspace (ADR 0316). */
export async function readFleetSeatImage(input: {
  readonly fleet: HerdrFleet;
  readonly shell: FleetShellRun;
  readonly workspace: string;
  readonly path: string;
}): Promise<SeatImageResult> {
  const result = answer(await input.shell(readCommand(input.fleet, input.workspace, input.path), 60_000));
  if (result.tag === REFUSED) return { outcome: "unavailable", message: result.rest };
  if (result.tag === LARGE) return seatImageTooLarge(input.path, Number(result.rest));
  const split = result.rest.lastIndexOf("\t");
  if (result.tag !== IMAGE || split < 0)
    return { outcome: "unavailable", message: `${input.fleet.id} didn't return the image.` };
  const data = result.rest.slice(split + 1).trim();
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(data))
    return { outcome: "unavailable", message: `${input.fleet.id} didn't return the image.` };
  return seatImageFromBytes(input.path, result.rest.slice(0, split), Buffer.from(data, "base64"));
}
