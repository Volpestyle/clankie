import config from "../../../../vitest.config.ts";
import { fileURLToPath } from "node:url";

export default {
  ...config,
  test: {
    ...config.test,
    include: [fileURLToPath(new URL("./store-isolation.fixture.ts", import.meta.url))],
    reporters: ["default"],
  },
};
