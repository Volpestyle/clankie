# Native fallback setup

The container run was interrupted by Docker HTTP 500s. The complete 20-run gate
used an isolated native Herdr session with pi 0.87.1, not the container's 0.84.2.

Use the source in [prove.md](prove.md), changing its import to the absolute
checkout `apps/clankie/src/captain/herdr-watch.ts`, its guard value from
`isolated-container` to `isolated-native`, and its working directory from
`/workspace` to `/tmp/vuh1373-native/workspace`. Bundle with the command in
the evidence README. The startup runner and store are unchanged.

Create `/tmp/vuh1373-native/{workspace,pi/extensions,config/herdr}`. The synthetic
`pi/models.json` is:

```json
{
  "providers": {
    "proof": {
      "baseUrl": "http://127.0.0.1:18081/v1",
      "api": "openai-completions",
      "apiKey": "synthetic",
      "models": [{ "id": "pi-worker" }]
    }
  }
}
```

`pi/settings.json` selects `defaultProvider: "proof"`, `defaultModel: "pi-worker"`.
`config/herdr/config.toml`:

```toml
onboarding = false
[terminal]
default_shell = "/bin/bash"
shell_mode = "non_login"
[update]
version_check = false
manifest_check = false
```

Use this launcher to select only test paths and a minimal environment:

```python
import os, subprocess, sys
root='/tmp/vuh1373-native'
env={k:os.environ[k] for k in ['HOME','USER','LOGNAME','TMPDIR'] if k in os.environ}
env.update(PATH='/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin', SHELL='/bin/bash', TERM='xterm-256color', PI_CODING_AGENT_DIR=root+'/pi', PI_OFFLINE='1', XDG_CONFIG_HOME=root+'/config', HERDR_CONFIG_PATH=root+'/config/herdr/config.toml', HERDR_SOCKET_PATH=root+'/config/herdr/sessions/vuh1373-native-readiness/herdr.sock',CLANKIE_PI_READINESS_PROOF='isolated-native',CLANKIE_PI_PROOF_CWD=root+'/workspace')
raise SystemExit(subprocess.call(sys.argv[1:], env=env,cwd=root+'/workspace'))
```

Run `python3 launch.py herdr --session vuh1373-native-readiness server`, then
`python3 launch.py node prove.mjs`. Stop only that named session after collecting
logs. Every created pane is closed by the harness. Only the model SSE response
is canned; the hired pi, Herdr process, session report, input path and saved pi
transcript are real. No external model account is used.

After the run, all 20 session files were independently parsed: each contained
an assistant message with `stopReason: "stop"` and a text block exactly
`PI_READY_DONE`. [native-pi-turns.jsonl](../logs/native-pi-turns.jsonl) captures
those assistant entries; unrelated system context is omitted.
