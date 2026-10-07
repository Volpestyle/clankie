#!/bin/sh
# Provision Clankie's Claude workers for the body's runtime user (VUH-1767): the
# worker plugin, installed and off (each hire enables it for its own session),
# and Herdr's Claude hook, which reports each session to Herdr. Runs at every
# body start, after the release root, so a self-installed release brings its own
# plugin. The image's managed settings approve the plugin's channel.
set -u
source_dir="${CLANKIE_CLAUDE_MARKETPLACE:-/state/install/current/integrations/claude-plugin}"
plugin=clankie-worker@clankie
command -v claude >/dev/null 2>&1 || exit 0
if [ ! -f "$source_dir/.claude-plugin/marketplace.json" ]; then
  echo "clankie: no Claude marketplace at $source_dir" >&2
  exit 1
fi
field() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const v=JSON.parse(s).find(e=>e[process.argv[1]]===process.argv[2]);process.stdout.write(v?String(v[process.argv[3]]??""):"")}catch{}})' "$@"; }

registered="$(claude plugin marketplace list --json 2>/dev/null | field name clankie path)"
if [ "$registered" != "$source_dir" ]; then
  [ -n "$registered" ] && claude plugin marketplace remove clankie >/dev/null 2>&1
  claude plugin marketplace add "$source_dir" >/dev/null || exit 1
else
  claude plugin marketplace update clankie >/dev/null 2>&1 || true
fi
if [ -n "$(claude plugin list --json 2>/dev/null | field id "$plugin" id)" ]; then
  claude plugin update "$plugin" >/dev/null 2>&1 || true
else
  claude plugin install "$plugin" --scope user >/dev/null || exit 1
fi
claude plugin disable "$plugin" --scope user >/dev/null 2>&1 || true
# Needs ~/.claude, which the plugin install above creates.
herdr integration install claude >/dev/null || exit 1
# A hired Claude must not stop at first-run prompts nobody will answer: mark the
# cosmetic onboarding (theme picker) done, keeping any choice already made, and
# trust the owner's own workspace (ADR 0238). Other folders keep their prompt.
# An ANTHROPIC_API_KEY the owner set on the body is their choice of key: record
# its approval as Claude does (the key's last 20 characters, never the key).
node -e '
const fs = require("node:fs"), path = `${process.env.HOME}/.claude.json`;
const workspace = process.env.CLANKIE_HOSTED_WORKSPACE || "/workspace";
let state = {};
try { state = JSON.parse(fs.readFileSync(path, "utf8")); } catch {}
const project = state.projects?.[workspace] ?? {};
const key = process.env.ANTHROPIC_API_KEY?.trim().slice(-20);
const responses = state.customApiKeyResponses ?? {};
const approved = (responses.approved ?? []).filter((entry) => entry !== key);
const keyDone = !key || (responses.approved ?? []).includes(key);
if (state.hasCompletedOnboarding === true && project.hasTrustDialogAccepted === true && keyDone) process.exit(0);
fs.writeFileSync(path, JSON.stringify({
  theme: "dark",
  ...state,
  hasCompletedOnboarding: true,
  projects: { ...state.projects, [workspace]: { ...project, hasTrustDialogAccepted: true } },
  ...(key
    ? {
        customApiKeyResponses: {
          ...responses,
          approved: [...approved, key],
          rejected: (responses.rejected ?? []).filter((entry) => entry !== key),
        },
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
try { settings = JSON.parse(fs.readFileSync(path, "utf8")); } catch {}
if (settings.permissions?.defaultMode !== undefined) process.exit(0);
fs.writeFileSync(path, JSON.stringify({ ...settings, permissions: { ...settings.permissions, defaultMode: "auto" } }, null, 2));
' || exit 1
