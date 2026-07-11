import { createLogger } from "@sapling/observability";

const logger = createLogger({
  service: "sapling-runner",
  version: "0.1.0",
  runnerId: process.env.SAPLING_RUNNER_ID ?? "local",
});
logger.info(
  {
    pid: process.pid,
    cwd: process.cwd(),
    node: process.version,
    controlPlane: process.env.SAPLING_CONTROL_PLANE_URL ?? "http://127.0.0.1:4310",
  },
  "runner skeleton started",
);
logger.warn(
  "No persistent command channel is connected. Implement milestone M2 before real worker execution.",
);
