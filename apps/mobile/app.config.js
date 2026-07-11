// Variant-aware Expo config (pattern carried over from clankies).
//
// The static base in `app.json` is the standalone identity — `io.clankie.v2`,
// home-screen name "Sapling". Dev-client builds (local `expo run` /
// scripts/ios-device.sh, gated on CLANKIE_VARIANT=dev) install ALONGSIDE it
// under their own bundle id + home-screen name so a future standalone build
// never fights the dev client for identity.
//
// The dev variant changes only the bundle id and CFBundleDisplayName — NOT
// `name` — so the generated Xcode project/scheme stays "Sapling" and
// scripts/ios-device.sh (which targets -scheme Sapling) works for both.

const DEV_BUNDLE_ID = "io.clankie.v2.dev";
const DEV_DISPLAY_NAME = "Sapling Dev";

/** @param {{ config: import('@expo/config-types').ExpoConfig }} ctx */
module.exports = ({ config }) => {
  const isDev = process.env.CLANKIE_VARIANT === "dev";

  if (!isDev) {
    return config;
  }

  return {
    ...config,
    ios: {
      ...config.ios,
      bundleIdentifier: DEV_BUNDLE_ID,
      infoPlist: {
        ...config.ios?.infoPlist,
        CFBundleDisplayName: DEV_DISPLAY_NAME,
      },
    },
    android: {
      ...config.android,
      package: DEV_BUNDLE_ID,
    },
  };
};
