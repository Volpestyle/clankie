# Native terminal component contract

Implement `SaplingTerminalSurface` as a Fabric/native component backed by SwiftTerm on iOS and macOS.

Required properties:

- `terminalId: string`
- `mode: observe | control`

Required native-to-JS events:

- `onReady`
- `onControlRequested`
- `onControlReleased`
- `onSelectionChanged`
- `onLinkActivated`
- `onError`

The native component renders terminal state only. Networking, replay sequence handling, control leases, and policy decisions remain in shared TypeScript services. Never stream the pane as video.
