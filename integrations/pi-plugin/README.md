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
before interpreting receipts or trying to resume an uncertain worker. The
production modules have local fake-native API and real transport fixtures;
these tests do not claim live native compatibility or a complete tool catalog.
