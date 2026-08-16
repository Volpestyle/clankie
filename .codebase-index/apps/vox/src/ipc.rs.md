# apps/vox/src/ipc.rs

Defines the complete stdin `InMsg` command and stdout `OutMsg` event contracts, typed error/telemetry payloads, and binary user-audio framing. Input lines cap at 8 MiB; control is unbounded and biased ahead of a bounded lossy audio lane. Output uses bounded control/audio/video/log lanes and strongly favors that order with nonblocking probes, but when all are initially empty the fallback `crossbeam::select!` is not strict priority and whichever ready lane wins may write first.
