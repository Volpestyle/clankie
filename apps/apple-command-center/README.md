# Apple command center

Shared React Native source for the iOS supervisory app and the full macOS command center.

## Version decision

Two version lanes import one framework-neutral shared source ([ADR 0009](../../docs/adr/0009-per-shell-react-native-versions.md)):

- **Mobile lane (iOS + Android):** Expo SDK 57, React Native `0.86`, Reanimated `4.5` + `react-native-worklets`, Skia `2.6.9`.
- **Desktop lane (macOS):** React Native `0.81.6` (pinned by `react-native-macos@0.81.8`), Reanimated `3.19.1`, Gesture Handler `3.0.2`, Skia `2.6.9`, new architecture enabled at pod install (`RCT_NEW_ARCH_ENABLED=1`).

Shared code is restricted to the Reanimated 3/4-common API subset (no CSS-style animation APIs, no direct `react-native-worklets` imports). Converge the lanes when `react-native-macos` reaches Reanimated 4's React Native floor (≥ 0.83); until then the macOS lane takes only 0.81 patch bumps. The package.json pins here describe the desktop lane; the mobile shell's versions are resolved by Expo SDK 57.

## Native shells

Generate separate iOS and macOS native projects, both importing this workspace source package. Do not force Expo into the macOS build. The iOS shell may use a development build, but shared application state and protocol code remain framework-neutral.

The first native milestone is not game progression. It is reliable pairing, event replay, garden/graph selection, approval handling, and safe terminal observation/control through a SwiftTerm native component.
