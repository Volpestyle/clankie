import { inspectMinecraftLiveReadiness } from "../src/readiness.ts";

const readiness = inspectMinecraftLiveReadiness();
const { javaExecutable: _javaExecutable, paperJarPath: _paperJarPath, ...receipt } = readiness;
process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
process.exit(readiness.status === "ready" ? 0 : 2);
