# Native desktop proof fixture

This is an input recipient, not a desktop-control provider. It records native
clicks, key receipt, text changes, drag/scroll events, application activation,
and key-window transitions as JSONL on stdout. A 100 ms heartbeat samples active
state and the frontmost PID. It never injects input or automatically activates
itself. Each run closes its own windows after the requested duration.

The target role creates two windows in one process; the operator role creates
one. Both have an opaque painted click target with no AX press action, plus an
accessible text editor. Use dummy text only: entered text is present in the log.

Build and check the inert entry points:

```sh
swift build --package-path tools/desktop-fixture --jobs 4
tools/desktop-fixture/.build/debug/ClankieDesktopFixture --help
python3 tools/desktop-fixture/check-inert.py
```

For an explicitly authorized native test, run two instances with separate logs:

```sh
tools/desktop-fixture/.build/debug/ClankieDesktopFixture --run operator --seconds 120 > /tmp/clankie-operator-fixture.jsonl
tools/desktop-fixture/.build/debug/ClankieDesktopFixture --run target --seconds 120 > /tmp/clankie-target-fixture.jsonl
```

Run these in separate terminals. The owner selects the operator window and
positions the target, including on another Space for that case. Drive only the
exact target PID/window reported in the log. Compare target counters/text with
the operator's continuous dummy typing and activation/key-window events over
the action interval. Capture fresh target pixels before and after. Verify the
physical pointer and active Space separately through the runtime under test.

An operator resignation during the action is a focus interruption even if it
is restored later. Heartbeat samples alone cannot rule out shorter transitions;
native event logs and continuous input are necessary evidence. Successful build
or inert checks establish no live background capability.
