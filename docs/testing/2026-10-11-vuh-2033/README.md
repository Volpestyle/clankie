# VUH-2033: owner-managed state symlinks

Tracks: https://linear.app/vuhlp/issue/VUH-2033

The service starts with `~/.local/state` symlinked to an owner-private directory,
with its actual `CLANKIE_STATE` inside that symlink. Both the default state-home
fallback and explicit `XDG_STATE_HOME` passed in the production composition root.
The captured production startup records below retain the link/target paths
and the decisive `clankie listening` log for each strengthened scenario.

The shared directory validator checks user link ownership, protected containing
directories, targets and link chains, then requires an owner-private final
capability/update directory. Root-owned OS aliases in protected root-owned
parents (such as macOS `/tmp`) remain usable. POSIX symlink mode bits do not
control access: directory permissions do. Companion roots retain their existing
readable-but-not-shared-writable policy and reuse the validator before resolving.
Private update file links remain refused through `O_NOFOLLOW`.

## Checks

- Initial helper/consumer run: 8 files, 81 tests passed.
- Final runtime/update consumer run: 6 files, 72 tests passed (72.64s).
- Final directory/companion/app run: 3 files, 13 tests passed (6.56s).
- Strengthened production startup in isolation: 1 file, 2 tests passed (17.25s).
- The security tests use real files, permissions and links, including an owned
  link to a root-owned target and nonprivate/shared-write target rejection.

- Formatter passed on all eight touched files (164ms), directly under the
  lead’s interim rule; only my own two queued formatter waiters were canceled.
- Focused `oxlint --deny-warnings` passed.

## Failed concurrent startup run

One of two strengthened startup cases timed out after 20 seconds before any
service log appeared: `expected '' to contain 'clankie listening'`. The combined
run had 3 files passing and 1 failing (13 passed, 1 failed). The unchanged startup
file passed both cases in isolation. Sampled machine load ratio was 14.10,
with CPU ratio 0.739; load is a plausible cause, not a proven diagnosis. No
assertion or timeout was weakened.

## Gaps

Creating a foreign-user-owned symlink requires ownership-changing privileges and
was not live-tested. Its ownership refusal is implemented; a real foreign-owned
target is tested. No owner configuration or live service was changed. No evals
or local full root gate were run. Integration owns the landing gate.

## Production startup records

```json
[
  {
    "xdg": false,
    "stateHome": "/private/tmp/cv-XIMMnT/tmp/symlink-state-jaewHF/home/.local/state",
    "target": "/private/tmp/cv-XIMMnT/tmp/symlink-state-jaewHF/dotfiles-state",
    "log": [
      {
        "level": 30,
        "time": "2026-10-11T06:31:09.652Z",
        "service": "clankie",
        "version": "0.2.0",
        "hostname": "127.0.0.1",
        "port": 0,
        "eventLogPath": "/private/tmp/cv-XIMMnT/tmp/symlink-state-jaewHF/home/.local/state/clankie/events.jsonl",
        "memoryDir": "/private/tmp/cv-XIMMnT/tmp/symlink-state-jaewHF/home/.local/state/clankie/memory",
        "settingsFilledNames": [
          "DISCORD_SERVERS",
          "DISCORD_ROOM_SKILLS",
          "DISCORD_ROLE",
          "DISCORD_FLEET_ENABLED",
          "DISCORD_TRACKING_LEVEL",
          "DISCORD_INGRESS_DM_POLICY",
          "DISCORD_INGRESS_CONTEXT_MESSAGES",
          "DISCORD_VOICE_JOIN_POLICY",
          "DISCORD_VOICE_CONSENT_POLICY",
          "DISCORD_ACTIVE_BODY",
          "DISCORD_USER_SESSION_DM_POLICY"
        ],
        "msg": "clankie listening"
      }
    ]
  },
  {
    "xdg": true,
    "stateHome": "/private/tmp/cv-XIMMnT/tmp/symlink-state-05o2V2/home/.local/state",
    "target": "/private/tmp/cv-XIMMnT/tmp/symlink-state-05o2V2/dotfiles-state",
    "log": [
      {
        "level": 30,
        "time": "2026-10-11T06:31:18.172Z",
        "service": "clankie",
        "version": "0.2.0",
        "hostname": "127.0.0.1",
        "port": 0,
        "eventLogPath": "/private/tmp/cv-XIMMnT/tmp/symlink-state-05o2V2/home/.local/state/clankie/events.jsonl",
        "memoryDir": "/private/tmp/cv-XIMMnT/tmp/symlink-state-05o2V2/home/.local/state/clankie/memory",
        "settingsFilledNames": [
          "DISCORD_SERVERS",
          "DISCORD_ROOM_SKILLS",
          "DISCORD_ROLE",
          "DISCORD_FLEET_ENABLED",
          "DISCORD_TRACKING_LEVEL",
          "DISCORD_INGRESS_DM_POLICY",
          "DISCORD_INGRESS_CONTEXT_MESSAGES",
          "DISCORD_VOICE_JOIN_POLICY",
          "DISCORD_VOICE_CONSENT_POLICY",
          "DISCORD_ACTIVE_BODY",
          "DISCORD_USER_SESSION_DM_POLICY"
        ],
        "msg": "clankie listening"
      }
    ]
  }
]
```
