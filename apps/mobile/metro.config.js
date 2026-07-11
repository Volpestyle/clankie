// Monorepo Metro wiring per ADR 0009 + the VUH-703 spike landmines:
// watchFolders + nodeModulesPaths with hierarchical lookup left ON
// (disableHierarchicalLookup breaks Expo-internal resolution).
const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];

// The shared package pins the DESKTOP lane (react-native 0.81.6, Reanimated
// 3.19) in its own dependencies, so hierarchical lookup would resolve those
// for any import inside apps/apple-command-center/src. Block the shared
// package's copies of every per-lane library so resolution falls through to
// this shell's versions (RN 0.86, Reanimated 4.5, one React, one Skia).
const sharedPkg = path.resolve(workspaceRoot, "apps/apple-command-center/node_modules");
const perLane = [
  "react",
  "react-native",
  "react-native-macos",
  "react-native-reanimated",
  "react-native-gesture-handler",
  "@shopify/react-native-skia",
];
config.resolver.blockList = perLane.map(
  (name) => new RegExp(`^${sharedPkg.replace(/[/\\.]/g, "\\$&")}/${name}(/.*)?$`),
);

module.exports = config;
