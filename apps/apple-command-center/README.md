# Apple command center

Shared React Native source for the iOS supervisory app and the full macOS command center.

## Version decision

The skeleton pins React Native `0.81.6` because `react-native-macos@0.81.8` currently peers with that exact React Native line. It pins React `19.1.4`, React Native Skia `2.6.9`, Reanimated `3.19.1`, and Gesture Handler `3.0.2`. Upgrade the iOS and macOS targets together after running the terminal, Skia, gesture, and reconnect test suites.

## Native shells

Generate separate iOS and macOS native projects, both importing this workspace source package. Do not force Expo into the macOS build. The iOS shell may use a development build, but shared application state and protocol code remain framework-neutral.

The first native milestone is not game progression. It is reliable pairing, event replay, garden/graph selection, approval handling, and safe terminal observation/control through a SwiftTerm native component.
