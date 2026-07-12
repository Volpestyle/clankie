# ADR 0009: Per-shell React Native versions with a shared API-subset source

Status: accepted (historical for this monorepo).

**Home today:** the command-center product (shells + shared RN UI) lives in the
private monorepo `Volpestyle/clankie-app`. This ADR still describes the version
lanes; paths such as `apps/mobile` / `packages/command-center` refer to that
product repo, not this agent OS tree.

## Context

The command-center app ships from one shared React Native source to three
platforms, but the two native shells cannot use the same React Native line
today (verified against npm, 2026-07-10):

- `react-native-macos` latest is `0.81.8` and peers on exactly `react-native@0.81.6`.
- `react-native-reanimated` 4.x peers on `react-native@0.83 - 0.86` and
  `react-native-worklets`; it cannot run on the 0.81 line.
- The carry-over source (clankies shell + garden) is written against
  Expo SDK 57 / RN 0.86 / Reanimated 4.5 / Skia 2.6.9.

Forcing one version means either freezing mobile on RN 0.81 with
Reanimated 3 (regressing the carry-over) or dropping macOS until
`react-native-macos` catches up.

## Decision

Run **two version lanes** importing one framework-neutral shared package:

| Lane    | Shell                                         | Versions                                                                                                                                                      |
| ------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mobile  | `apps/mobile` Expo dev-client (iOS + Android) | Expo SDK 57, RN 0.86, Reanimated 4.5 + `react-native-worklets`, Skia 2.6.9                                                                                    |
| Desktop | `apps/macos` bare `react-native-macos`        | RN 0.81.6, `react-native-macos` 0.81.8, Reanimated 3.19, gesture-handler 3.0.2, Skia 2.6.9, new architecture **on** (`RCT_NEW_ARCH_ENABLED=1` at pod install) |

`packages/command-center` publishes the source-form `@clankie/command-center`
entry consumed by both shells. Shared code is constrained to the **API subset present in both Reanimated
3.19 and 4.5** and otherwise version-agnostic:

- Reanimated: `useSharedValue`, `useDerivedValue`, `useAnimatedStyle`,
  `useFrameCallback`, `withSpring`/`withTiming`, `Animated.*` components.
  No Reanimated-4-only APIs (CSS transitions/animations) and no direct
  `react-native-worklets` imports in shared code.
- Gesture Handler: the `Gesture.*` + `GestureDetector` API (stable across
  2.x/3.x).
- Skia stays a single version across lanes (currently 2.6.9): `Atlas`,
  `useImage`, `useRSXformBuffer`, `useRectBuffer`, `Canvas`.

Per-shell configuration (not shared): the bare macOS shell needs
`react-native-reanimated/plugin` in its babel config; Expo's preset covers
the mobile lane. Each shell's metro config adds the workspace to
`watchFolders` and its own `node_modules` to `resolver.nodeModulesPaths`
with hierarchical lookup left on. macOS owns port 8081 and mobile owns port
8082; native builds bake their lane's port.

## Upgrade trigger

Converge to a single lane when `react-native-macos` ships a line whose
React Native peer satisfies Reanimated 4's floor (≥ 0.83). Check on every
`react-native-macos` minor release; until then the macOS lane only takes
patch bumps within 0.81.

## Evidence (spike, 2026-07-10, VUH-703)

Representative slice: clankies pixel atlas (pinned `d0de8a5`) rendered via
Skia `Atlas` with `useFrameCallback`-driven RSXform buffers, plus a spring
dock pill under a pan gesture — the garden's and the shell's exact render
paths.

- iOS (Expo lane): fully verified on simulator — sprites render crisp,
  UI-thread animation confirmed by frame diffing, banner shows
  `RN 0.86.0 · Reanimated 4.5.0`.
- Android (Expo lane): same shared source; verified via headless emulator.
- macOS (desktop lane): pods + build clean under Fabric; Metro serves the
  shared bundle without errors under Reanimated 3.19; process sampling
  shows `REANodesManager → ReanimatedModuleProxy::onRender` executing the
  shared worklets. On-screen confirmation pending an unlocked session.

Landmines recorded for the restructure (VUH-704):

- pnpm 11 blocks postinstall scripts by default — approve builds in
  workspace config (see `ecdbfc2`).
- `expo-asset` must be an explicit dependency of the mobile shell.
- Metro's `disableHierarchicalLookup` breaks Expo-internal resolution;
  use `nodeModulesPaths` only.
- The dev-server port is baked into native builds (`RCT_METRO_PORT`);
  running both lanes concurrently needs distinct ports planned up front.
- Inset-only absolute fills collapsed to zero height at the spike's root;
  size roots explicitly (the ported clankies shell brings its own proven
  root structure).
