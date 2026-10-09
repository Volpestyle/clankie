#!/bin/sh
# Provision Clankie's Claude workers for the body's runtime user (VUH-1767): the
# worker plugin, installed and off (each hire enables it for its own session),
# and Herdr's Claude hook, which reports each session to Herdr. Runs at every
# body start, after the release root, so a self-installed release brings its own
# plugin. The image's managed settings approve the plugin's channel.
set -eu
umask 077
source_dir="${CLANKIE_CLAUDE_MARKETPLACE:-/state/install/current/integrations/claude-plugin}"
plugin=clankie-worker@clankie
stamp="$HOME/.claude/clankie-hosted-setup.sha256"
command -v claude >/dev/null 2>&1 || exit 0
if [ ! -f "$source_dir/.claude-plugin/marketplace.json" ]; then
  rm -f "$stamp"
  echo "clankie: no Claude marketplace at $source_dir" >&2
  exit 1
fi
# Cache only successful reconciliation. Local digests include the shipped plugin,
# CLI identities, installed plugin contents and owner-controlled setup inputs.
# No authentication material is written to the stamp or logs.
fingerprint() {
  CLANKIE_SETUP_SOURCE="$source_dir" CLANKIE_SETUP_SCRIPT="$0" \
  CLANKIE_SETUP_CLAUDE="$(command -v claude)" CLANKIE_SETUP_HERDR="$(command -v herdr)" node -e '
const fs = require("node:fs"), crypto = require("node:crypto"), path = require("node:path");
process.on("uncaughtException", () => { console.error("clankie: cannot fingerprint Claude worker setup"); process.exit(1); });
const hash = crypto.createHash("sha256");
function file(p) {
  hash.update(p);
  try { hash.update(String(fs.statSync(p).mode)); hash.update(fs.readFileSync(p)); }
  catch (e) { if (e.code !== "ENOENT") throw e; hash.update("missing"); }
}
function tree(p) {
  hash.update(p);
  if (!fs.existsSync(p)) { hash.update("missing"); return; }
  for (const entry of fs.readdirSync(p, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
    if (entry.name === ".git") continue;
    const child = path.join(p, entry.name);
    if (fs.statSync(child).isDirectory()) tree(child); else file(child);
  }
}
file(process.env.CLANKIE_SETUP_SCRIPT);
const source = fs.realpathSync(process.env.CLANKIE_SETUP_SOURCE);
file(`${source}/.claude-plugin/marketplace.json`);
tree(`${source}/worker`);
for (const cli of [process.env.CLANKIE_SETUP_CLAUDE, process.env.CLANKIE_SETUP_HERDR]) {
  const real = fs.realpathSync(cli), stat = fs.statSync(real);
  hash.update(JSON.stringify([real, stat.size, stat.mtimeMs, stat.ctimeMs, stat.ino]));
}
const home = process.env.HOME, workspace = process.env.CLANKIE_HOSTED_WORKSPACE || "/workspace";
for (const name of ["settings.json", "settings.local.json", "hooks/herdr-agent-state.sh", ".credentials.json", "plugins/known_marketplaces.json", "plugins/installed_plugins.json"])
  file(`${home}/.claude/${name}`);
file("/etc/claude-code/managed-settings.json");
const registry = `${home}/.claude/plugins/installed_plugins.json`;
if (fs.existsSync(registry)) {
  const plugins = JSON.parse(fs.readFileSync(registry, "utf8")).plugins;
  for (const entry of plugins?.["clankie-worker@clankie"] || []) if (entry.installPath) tree(entry.installPath);
}
let state = {};
try { state = JSON.parse(fs.readFileSync(`${home}/.claude.json`, "utf8")); }
catch (e) { if (e.code !== "ENOENT") throw e; }
hash.update(JSON.stringify([workspace, state.hasCompletedOnboarding, state.theme,
  state.projects?.[workspace]?.hasTrustDialogAccepted, state.customApiKeyResponses,
  state.oauthAccount, process.env.ANTHROPIC_API_KEY || ""]));
process.stdout.write(hash.digest("hex"));
'
}
current="$(fingerprint)" || { rm -f "$stamp"; exit 1; }
if [ -f "$stamp" ] && [ "$(cat "$stamp")" = "$current" ]; then
  echo "clankie: Claude worker setup unchanged" >&2
  exit 0
fi
# Invalidate before attempting repair: interrupted or failed setup always retries.
rm -f "$stamp"
field() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const v=JSON.parse(s).find(e=>e[process.argv[1]]===process.argv[2]);process.stdout.write(v?String(v[process.argv[3]]??""):"")}catch{}})' "$@"; }

registered="$(claude plugin marketplace list --json 2>/dev/null | field name clankie path)"
if [ "$registered" != "$source_dir" ]; then
  [ -n "$registered" ] && claude plugin marketplace remove clankie >/dev/null 2>&1
  claude plugin marketplace add "$source_dir" >/dev/null || exit 1
else
  claude plugin marketplace update clankie >/dev/null 2>&1 || exit 1
fi
if [ -n "$(claude plugin list --json 2>/dev/null | field id "$plugin" id)" ]; then
  claude plugin update "$plugin" >/dev/null 2>&1 || exit 1
else
  claude plugin install "$plugin" --scope user >/dev/null || exit 1
fi
# Claude 2.1.281 returns 1 when the user-scoped plugin is already disabled.
# Accept that idempotent result only after verifying the desired native state.
claude plugin disable "$plugin" --scope user >/dev/null 2>&1 || node -e '
try {
  const settings = JSON.parse(require("node:fs").readFileSync(`${process.env.HOME}/.claude/settings.json`, "utf8"));
  process.exit(settings.enabledPlugins?.["clankie-worker@clankie"] === false ? 0 : 1);
} catch { process.exit(1); }
' || exit 1
# Needs ~/.claude, which the plugin install above creates.
herdr integration install claude >/dev/null || exit 1
# A hired Claude must not stop at first-run prompts nobody will answer: mark the
# cosmetic onboarding (theme picker) done, keeping any choice already made, and
# trust the owner's own workspace (ADR 0238). Other folders keep their prompt.
# An ANTHROPIC_API_KEY the owner set on the body is their choice of key: record
# its approval as Claude does (the key's last 20 characters, never the key),
# unless they signed Claude into their subscription, which then wins.
subscription=false
# Without the env key, a signed-in Claude is the subscription.
env -u ANTHROPIC_API_KEY claude auth status --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.exit(JSON.parse(s).loggedIn===true?0:1)}catch{process.exit(1)}})' && subscription=true
CLANKIE_CLAUDE_SUBSCRIPTION="$subscription" node -e '
const fs = require("node:fs"), path = `${process.env.HOME}/.claude.json`;
const subscription = process.env.CLANKIE_CLAUDE_SUBSCRIPTION === "true";
const workspace = process.env.CLANKIE_HOSTED_WORKSPACE || "/workspace";
let state = {};
try { state = JSON.parse(fs.readFileSync(path, "utf8")); } catch (e) { if (e.code !== "ENOENT") { console.error("clankie: invalid Claude first-run state"); process.exit(1); } }
const project = state.projects?.[workspace] ?? {};
const key = process.env.ANTHROPIC_API_KEY?.trim().slice(-20);
const responses = state.customApiKeyResponses ?? {};
const approved = (responses.approved ?? []).filter((entry) => entry !== key);
const rejected = (responses.rejected ?? []).filter((entry) => entry !== key);
const keyDone = !key || (subscription ? (responses.rejected ?? []) : (responses.approved ?? [])).includes(key);
if (state.hasCompletedOnboarding === true && project.hasTrustDialogAccepted === true && keyDone) process.exit(0);
fs.writeFileSync(path, JSON.stringify({
  theme: "dark",
  ...state,
  hasCompletedOnboarding: true,
  projects: { ...state.projects, [workspace]: { ...project, hasTrustDialogAccepted: true } },
  ...(key
    ? {
        customApiKeyResponses: subscription
          ? { ...responses, approved, rejected: [...rejected, key] }
          : { ...responses, approved: [...approved, key], rejected },
      }
    : {}),
}, null, 2), { mode: 0o600 });
' || exit 1
# Nobody answers a hosted worker's permission prompts: Claude's auto mode lets
# its own safety classifier approve routine work and refuse risky actions
# (ADR 0238). An owner's own default mode is kept.
node -e '
const fs = require("node:fs"), path = `${process.env.HOME}/.claude/settings.json`;
let settings = {};
try { settings = JSON.parse(fs.readFileSync(path, "utf8")); } catch (e) { if (e.code !== "ENOENT") { console.error("clankie: invalid Claude settings"); process.exit(1); } }
if (settings.permissions?.defaultMode !== undefined) process.exit(0);
fs.writeFileSync(path, JSON.stringify({ ...settings, permissions: { ...settings.permissions, defaultMode: "auto" } }, null, 2));
' || exit 1

# Rename on the same filesystem publishes success atomically. Recompute because
# plugin installation and first-run defaults changed the inputs above.
current="$(fingerprint)" || exit 1
temporary="$stamp.tmp.$$"
trap 'rm -f "$temporary"' EXIT HUP INT TERM
printf '%s\n' "$current" > "$temporary"
mv -f "$temporary" "$stamp"
