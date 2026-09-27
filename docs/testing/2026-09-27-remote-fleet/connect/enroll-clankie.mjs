// PREPARED ONLY. The PC lead runs this explicitly, from its enrolled environment.
// Never starts an owner, runs a harness, or changes an existing worker identity.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

if (process.platform !== "win32") throw new Error("Run on the PC as its project lead");
const scope = process.env.SWARM_SCOPE;
if (!scope) throw new Error("Run in the existing Rivals lead's enrolled environment (SWARM_SCOPE required)");
const runtime = await import(
  pathToFileURL("C:\\Users\\volpe\\swarm-mcp-launch\\dist\\coordination\\runtime.js").href
);
const owner = JSON.parse(readFileSync("C:\\Users\\volpe\\.swarm-mcp\\rivals\\owner.json", "utf8"));
const endpoint = runtime.localEndpoint(owner.databasePath);
if (process.env.SWARM_COORDINATOR_ENDPOINT !== endpoint)
  throw new Error("The lead environment does not point at the Rivals coordinator");
const directory = join(process.env.USERPROFILE, ".clankie-rivals-peer");
// Private ACL at creation, or fail closed if an existing directory is exposed.
const privacy = String.raw`
$ErrorActionPreference = 'Stop'
$target = $env:CLANKIE_PEER_DIRECTORY
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$sid = $identity.User
$directory = [System.IO.DirectoryInfo]::new($target)
if (-not $directory.Exists) {
  $acl = [System.Security.AccessControl.DirectorySecurity]::new()
  $acl.SetOwner($sid)
  $acl.SetAccessRuleProtection($true, $false)
  $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid, [System.Security.AccessControl.FileSystemRights]::FullControl, [System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit', [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow))
  $directory.Create($acl)
}
if (($directory.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Refusing reparse point' }
$acl = $directory.GetAccessControl()
if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -notin @($sid.Value, $identity.Owner.Value)) { throw 'Different directory owner' }
foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
  if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin @($sid.Value, 'S-1-5-18', 'S-1-5-32-544')) { throw 'Directory grants access to another principal' }
}
`;
execFileSync(
  "powershell.exe",
  ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(privacy, "utf16le").toString("base64")],
  {
    env: { ...process.env, CLANKIE_PEER_DIRECTORY: directory },
    stdio: "pipe",
    timeout: 10000,
  },
);
const retained = join(directory, "launcher.json");
if (!existsSync(retained))
  writeFileSync(
    retained,
    JSON.stringify({
      scope,
      agentId: randomUUID(),
      requestId: randomUUID(),
      resumeToken: randomBytes(32).toString("hex"),
    }),
    { flag: "wx", mode: 0o600 },
  );
const identity = JSON.parse(readFileSync(retained, "utf8"));
if (identity.scope !== scope) throw new Error("Retained Clankie identity belongs to another scope");
const output = join(directory, "rivals-connect.json");
if (existsSync(output))
  throw new Error("Private connection file already exists; transfer it without enrolling again");
// Direct launcher enrollment contacts ONLY the running owner. In particular,
// do not use enrollRuntime/ensureCoordinator, which may start an absent owner.
const client = await runtime.CoordinationClient.connect(endpoint, owner.launcherSecret);
try {
  const session = await client.request({
    op: "enroll",
    input: { ...identity, label: "clankie:global-default" },
  });
  writeFileSync(
    output,
    JSON.stringify(
      {
        id: "rivals",
        conversationId: "global-default",
        ssh: "pc",
        endpoint,
        capability: session.capability,
      },
      null,
      2,
    ) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      written: output,
      actor: session.actor,
      scope: session.scope,
      replayed: session.replayed,
    }),
  );
} finally {
  client.close();
}
