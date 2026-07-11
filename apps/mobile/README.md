# Sapling mobile shell

Expo dev-client shell (iOS + Android) for the shared command-center source in
`apps/apple-command-center`, on the mobile version lane of
[ADR 0009](../../docs/adr/0009-per-shell-react-native-versions.md):
Expo SDK 57, React Native 0.86, Reanimated 4.5 + `react-native-worklets`,
Skia 2.6.9. Metro runs on **8082** (macOS lane owns 8081; the dev-server port
is baked into native builds).

The shared package pins the desktop lane in its own `dependencies`, so
`metro.config.js` blocklists the shared package's copies of every per-lane
library — resolution falls through to this shell's versions. Keep that list in
sync when the shared package gains a new per-lane native dependency.

App identity follows the clankies variant pattern (`app.config.js`): standalone
builds are `io.clankie.v2` / "Sapling", dev-client builds
(`CLANKIE_VARIANT=dev`) are `io.clankie.v2.dev` / "Clankie Dev" so both can
coexist on one device.

```sh
pnpm --filter @sapling/mobile start        # Metro (dev client) on :8082
pnpm --filter @sapling/mobile ios          # build + run on the iOS simulator
pnpm --filter @sapling/mobile ios:device   # build + install + launch on a physical
                                           # iPhone/iPad with Metro advertised over
                                           # Tailscale MagicDNS (see scripts/ios-device.sh)
```

Native projects are generated (`expo prebuild`), never edited by hand, and not
tracked; `ios:device` runs prebuild automatically when the workspace is missing
or carries the wrong variant.
