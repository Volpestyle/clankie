# VUH-869 Herdr terminal source live probe

The read-only protocol probe runs against Herdr 0.7.1, socket protocol 15, on 2026-07-14. It uses a scratch pane for input and closes that pane after the probe. No existing pane receives input.

Commands exercised:

```text
herdr --version
herdr api schema --output /tmp/herdr-0.7.1-api-schema.json
herdr pane list
herdr pane split --direction right --cwd /tmp
herdr pane read <scratch-pane> --source visible --format ansi
pane.attach {"pane_id":"<scratch-pane>"}
pane.send_input {"pane_id":"<scratch-pane>","text":"printf 'VUH869-λ🙂\\n'\\n","keys":[]}
herdr pane close <scratch-pane>
```

`pane.list` returns both a compact session-local `pane_id` and a stable `terminal_id`; it also returns private metadata that the adapter intentionally drops. `pane.read` returns visible ANSI text and a truncation flag. Raw `pane.attach` first returns `pane_attached`, then NDJSON stream envelopes containing contiguous positive `seq` values and base64 bytes. The scratch pane rendered the Unicode input, and its close removed it from subsequent discovery.

The deterministic fake-transport suite owns gap, burst, reconnect, alternate-screen, closure, and control-lease coverage. The live probe establishes the protocol/version shape without recording pane identity, terminal content, credentials, or socket paths in repository evidence.
