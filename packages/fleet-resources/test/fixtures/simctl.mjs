// Executable CoreSimulator boundary fixture. It never invokes xcrun or simctl.
import { randomUUID } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const [statePath, logPath, ...args] = process.argv.slice(2);
appendFileSync(logPath, `${JSON.stringify(args)}\n`);
const state = JSON.parse(readFileSync(statePath, "utf8"));
const save = () => writeFileSync(statePath, JSON.stringify(state));
const command = args[0];
const operation = command === "bootstatus" ? "boot" : command;
const fault = state.fault?.operation === operation ? state.fault : undefined;
if (fault) {
  delete state.fault;
  save();
}
const fail = () => {
  process.stderr.write("fixture native command failed\n");
  process.exit(1);
};
if (fault?.before) fail();
if (command === "list" && args[1] === "devicetypes" && args[2] === "--json" && args.length === 3) {
  const types =
    state.deviceTypes ??
    ["iPhone-17-Pro", "iPhone-13-mini", "iPad-Air-11-inch-M3", "iPad-Air-11-inch-M4"].map(
      (name) => `com.apple.CoreSimulator.SimDeviceType.${name}`,
    );
  process.stdout.write(
    JSON.stringify({
      devicetypes: types.map((identifier) => ({ identifier, name: identifier.split(".").pop() })),
    }),
  );
} else if (command === "list" && args[1] === "runtimes" && args[2] === "--json" && args.length === 3) {
  process.stdout.write(
    JSON.stringify({
      runtimes: (state.runtimes ?? ["com.apple.CoreSimulator.SimRuntime.iOS-27-0"]).map((identifier) => ({
        identifier,
        isAvailable: true,
      })),
    }),
  );
} else if (command === "list") {
  if (JSON.stringify(args) !== JSON.stringify(["list", "devices", "--json"]))
    throw new Error("Unbounded fixture inventory");
  process.stdout.write(JSON.stringify({ devices: state.devices }));
} else if (command === "create") {
  if (args.length !== 4 || !/^Clankie-[a-f0-9-]{36}$/u.test(args[1]))
    throw new Error("Invalid fixture create");
  const udid = randomUUID().toUpperCase();
  state.devices[args[3]] ??= [];
  state.devices[args[3]].push({
    udid,
    name: args[1],
    state: "Shutdown",
    isAvailable: true,
    deviceTypeIdentifier: args[2],
  });
  save();
  if (fault?.after) fail();
  process.stdout.write(`${udid}\n`);
} else {
  if (!/^[A-F0-9]{8}(?:-[A-F0-9]{4}){3}-[A-F0-9]{12}$/u.test(args[1] ?? ""))
    throw new Error("Only exact fixture UUIDs are accepted");
  const entries = Object.entries(state.devices);
  const found = entries
    .flatMap(([runtime, devices]) => devices.map((device) => ({ runtime, device })))
    .find((row) => row.device.udid === args[1]);
  if (!found) fail();
  if (command === "bootstatus" && args.length === 3 && args[2] === "-b") {
    // A slow first boot: the fixture holds bootstatus open for bootDelayMs.
    // It re-reads the state afterwards so concurrent fixture commands are kept.
    if (state.bootDelayMs) {
      await new Promise((resolve) => setTimeout(resolve, state.bootDelayMs));
      const current = JSON.parse(readFileSync(statePath, "utf8"));
      for (const key of Object.keys(state)) delete state[key];
      Object.assign(state, current);
      const device = Object.values(state.devices)
        .flat()
        .find((row) => row.udid === args[1]);
      if (!device) fail();
      device.state = fault?.state ?? "Booted";
    } else found.device.state = fault?.state ?? "Booted";
  } else if (command === "shutdown" && args.length === 2) found.device.state = fault?.state ?? "Shutdown";
  else if (command === "delete" && args.length === 2) {
    if (found.device.state !== "Shutdown") throw new Error("Fixture refuses deletion before shutdown");
    state.devices[found.runtime] = state.devices[found.runtime].filter((device) => device.udid !== args[1]);
  } else throw new Error("Unsupported fixture command");
  save();
  if (fault?.after) fail();
}
