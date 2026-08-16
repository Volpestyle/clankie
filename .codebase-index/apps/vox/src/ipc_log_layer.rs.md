# apps/vox/src/ipc_log_layer.rs

Implements a tracing subscriber layer that forwards info-and-higher records through Vox's bounded IPC log lane once the writer is ready. Structured fields and message text reach Clankie without letting log traffic preempt media/control lanes.
