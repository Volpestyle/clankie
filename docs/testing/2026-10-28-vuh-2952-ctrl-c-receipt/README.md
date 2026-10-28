# Ctrl-C fixture receipt publication — VUH-2952

The heavy CLI child created `signal-ready.json` before writing its JSON. The
parent waited for existence, so a loaded machine could expose an empty receipt
to `JSON.parse`. This is a test-side readiness race.

The child now writes a `.pending` file and renames it only after the JSON is
complete. A deliberate 500 ms gap after creating the pending file keeps the
adverse schedule exercised. Ctrl-C forwarding, exit 130, owned-process-gone and
released-governor-capacity assertions are unchanged. No production code or
timeout changes.

On fetched main `ae3709796`, exposing the final filename empty for the same
500 ms gap reproduces `Unexpected end of JSON input` at the existing reader
(exit 1). Publishing by rename passes the full integration file: 13/13 tests
(exit 0). Formatting passes. All checks used `clankie heavy --`; the CLI fixture
uses its own temporary HOME, settings, credentials and governor.

The archive contains the original, injected-red and final test source, exact
diff, raw red/green logs and source hash. Landing verification follows the root
gate and standing review separately.
