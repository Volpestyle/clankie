// No timer, socket, or other keepalive surrounds the final top-level await.
// A unit test runner's handles would hide a transport shutdown that exits13.
import { pathToFileURL } from "node:url";
const [transportPath, helper, mode] = process.argv.slice(2);
const { nativeProcessRequest, closeNativeProcessObservers } = await import(pathToFileURL(transportPath).href);
const reply = await nativeProcessRequest(helper, [
  mode === "exit-without-close" ? "idle-with-keepalive" : "idle-before-close",
]);
if (!reply) throw new Error("Real helper reply unavailable");
const { pid } = JSON.parse(reply.stdout);
if (mode === "exit-without-close") {
  process.stdout.write(JSON.stringify({ completed: true, helperPid: pid }) + "\n", () => process.exit(0));
} else {
  await closeNativeProcessObservers();
  let absent = false;
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error.code === "ESRCH") absent = true;
    else throw error;
  }
  if (!absent) throw new Error("Owned helper still alive after transport close");
  process.stdout.write(JSON.stringify({ completed: true, helperPid: pid, absent }) + "\n");
}
