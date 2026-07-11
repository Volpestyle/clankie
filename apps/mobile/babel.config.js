module.exports = function (api) {
  api.cache(true);
  return {
    presets: ["babel-preset-expo"],
    // react-native-worklets/plugin must be last (drives Reanimated 4 worklets).
    plugins: ["react-native-worklets/plugin"],
  };
};
