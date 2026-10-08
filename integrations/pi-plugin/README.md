# Pi worker extension

The local native hire adapter loads `worker.mjs` with Pi's supported `--extension`
flag in the original Herdr process. The extension uses the selected native Pi
API; it does not import Clankie's service Pi dependency.

`worker-runtime.mjs` owns native session observation, custom-message follow-up
and steering, receipt correlation, settlement and observed interruption.
`worker-connection.mjs` owns one authenticated localhost control connection with
bounded UTF-8 framing. Neither module installs plugins, changes account or trust
settings, owns a model process, or implements fleet-tool authorization.

The adapter prepares the endpoint and token only for that launch. Original
process/socket and session admission lives in Clankie's controller and the shared
prepared-native host. A token or reported native path alone cannot attach control.

Read the [implementation and live acceptance boundary](../../docs/testing/2026-10-04-pi-workers/README.md)
before interpreting receipts or trying to resume an uncertain worker. The control modules have fake-native API and real transport fixtures.
The fleet consumer additionally has installed Pi 0.87.1 SDK / real MCP subprocess
integration coverage, without provider turns; see the
[fleet boundary evidence](../../docs/testing/2026-10-08-pi-worker-fleet-mcp/README.md).
Neither fixture proves a live hire.

## Fleet tools

`worker.mjs` attaches a thin MCP consumer in the original native TUI. It starts
one `clankie mcp --fleet` subprocess, using the existing fleet bridge and its
server-advertised tools, schemas and instructions. It adds no operator fallback,
account registry or worker authority. The existing controller must authorize the
original session before each call; the MCP service remains authoritative for
current membership and tool access.

Only the initial TUI session receives tools. RPC mode, native session replacement,
controller loss and MCP process loss cannot reconnect or launch a replacement.
Catalog notifications refresh schemas, deactivate withdrawn tools and preserve
tools the owner disabled. Held stale definitions refuse before forwarding.
Native project trust and pre-dispatch cancellation also refuse without a call.

A tool invocation forwards once. Content, structured results, error flags and
original receipts survive the native Pi result boundary. Cancellation or a lost
MCP reply means the call may have applied: do not replay it. Reconcile the original
receipt through the advertised tools when one was returned. Release packaging
bundles this separate extension asset with its MCP dependencies; it does not
require Clankie's node_modules in the native Pi installation.
