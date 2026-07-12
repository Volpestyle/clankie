---
description: Use when running or verifying the command-center app (or spike slices) on the iOS simulator, Android emulator, or macOS locally — evidence loops, headless techniques, and environment gotchas learned from real runs.
---

# Verify the app on simulators

Prefer captured evidence (screenshots, frame diffs, logs, process samples) over "it looked fine". Animation claims need two frames compared, not one.

## Version lanes and Metro ports

- Two lanes per [ADR 0009](../../../docs/adr/0009-per-shell-react-native-versions.md): mobile (Expo SDK 57 / RN 0.86 / Reanimated 4.5) and macOS (react-native-macos 0.81 / Reanimated 3.19). Shared code sticks to the Reanimated 3/4-common API subset.
- The dev-server port is **baked into native builds** (`RCT_METRO_PORT`); `run-macos --port` does NOT retarget an already-built app. Convention: macOS Metro on **8081**, mobile Metro on **8082** (`expo start --port 8082`).
- A stale Metro from another checkout/scratchpad answers `/status` on the conventional port and the app silently loads the **wrong bundle**. Before reusing a running Metro, verify the listener's cwd is your app dir: `lsof -a -p "$(lsof -tnP -iTCP:8082 -sTCP:LISTEN)" -d cwd -Fn` (`apps/mobile/scripts/ios-device.sh` does this and dies on foreign owners).
- Metro monorepo wiring for shared-source shells: `watchFolders` + `resolver.nodeModulesPaths` with hierarchical lookup **left on** — `disableHierarchicalLookup: true` breaks Expo's internal imports (first symptom: `Unable to resolve module expo-asset`). `expo-asset` must also be an explicit dependency of the Expo shell.

## Interactive prompts stall pane runs

`create-expo-app` (SDK version) and `expo run` (port conflict) block on prompts. When a pane command seems hung, read the pane — it is usually waiting for Enter. Answer with `herdr pane send-keys <pane> Enter`.

## iOS simulator

- Bundle id: don't guess — `xcrun simctl listapps booted | grep -v com.apple` (Expo prebuild derives it from the owner, e.g. `com.volpestyle.mobile`).
- Screenshot: `xcrun simctl io booted screenshot f.png`. Animation proof: two shots ~1.5s apart, then `cmp` (PIL is not installed; downscale with `sips -Z 1000 in.png --out out.png`).
- The Expo dev-menu onboarding sheet covers the app on every fresh launch and `simctl` cannot tap. Disable it instead:
  `xcrun simctl spawn booted defaults write <bundleid> EXDevMenuIsOnboardingFinished -bool YES`, then `simctl terminate` + `launch`.
- Force a clean relaunch: `xcrun simctl terminate booted <bundleid>; xcrun simctl launch booted <bundleid>`. Reload JS from the Expo CLI pane by sending `r`.

## Android emulator (fully headless)

- Discover the environment instead of assuming shell-profile state: default `ANDROID_HOME` to `$HOME/Library/Android/sdk`, resolve `JAVA_HOME` from `brew --prefix openjdk@21` when absent, and prepend the SDK's `platform-tools` and `emulator` directories to `PATH`.
- List available devices with `emulator -list-avds`; use the repo convention `clankie` only when it is present. Headless boot:
  `emulator -avd <avd> -no-window -no-audio -no-boot-anim -gpu swiftshader_indirect`.
- Wait for boot: `adb wait-for-device` then poll `adb shell getprop sys.boot_completed` until `1`.
- Evidence: `adb exec-out screencap -p > f.png`; interact with `adb shell input tap <x> <y>` (scale coordinates from any downscaled screenshot back to device pixels).

## macOS app

- **A locked/asleep session lies to you**: the app runs but System Events reports 0 windows and `screencapture` returns black (or the lock screen after `caffeinate -u`). Do not diagnose "window never created" until you've full-screen-captured and checked for the lock screen. On-screen confirmation from a locked session is a human step — hand it off.
- Functional verification without a screen: Metro's `BUNDLE` + connection logs prove the bundle loads; `sample <AppName> 2` proves the render loop (e.g. `REANodesManager → ReanimatedModuleProxy::onRender` in the call graph = Reanimated worklets executing).
- Launching the `.app` binary directly with output piped to `tail` buffers everything; run it unpiped in a pane for live logs.
- New architecture is opt-in on react-native-macos 0.81: `RCT_NEW_ARCH_ENABLED=1 pod install --project-directory=macos` (Skia 2.x requires it).

## herdr coordination

Sentinel matching scans scrollback and the echoed command line — make sentinels unique per run and match with anchored regex (`^SENTINEL_x1_(OK|BAD)$`). Pane ids compact when panes close; re-read `$HERDR_PANE_ID` or `herdr pane list` before reporting presence late in a session.
