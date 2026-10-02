import config from "./vitest.config.ts";

const corpus = "packages/play/test/free-play-corpus.test.ts";

export default {
  ...config,
  test: {
    ...config.test,
    include: [corpus],
    exclude: config.test.exclude.filter((pattern) => pattern !== corpus),
  },
};
