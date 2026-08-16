# apps/vox/src/ipc_protocol.rs

Projects the large wire-level `InMsg` enum into four operational command families: connection, capture, playback, and stream publish. `RoutedInMsg` gives the runtime a stable dispatch seam without duplicating serialized IPC shapes in supervisors.
