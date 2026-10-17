// The parent's already-connected HTTP socket is inherited as fd 3. Do not read
// or write it: retaining the descriptor supplies a real second kernel owner.
// With a control path and name, this process is the heir of a handoff instead:
// it outlives its parent and, only when told, sends a request on that inherited
// connection, so the original owner can exit while the connection stays open.
import { connect, Socket } from "node:net";
import { request } from "node:http";
import { createInterface } from "node:readline";

const [controlPath, name, endpoint] = process.argv.slice(2);
if (!controlPath) {
  process.send({ ready: true, pid: process.pid });
  setInterval(() => {}, 1_000);
} else {
  const control = connect(controlPath);
  let inherited;
  control.on("connect", () => control.write(JSON.stringify({ ready: name, pid: process.pid }) + "\n"));
  control.on("error", () => process.exit(1));
  control.on("close", () => process.exit(0));
  for await (const line of createInterface({ input: control })) {
    const command = JSON.parse(line);
    if (command.quit) {
      control.end();
      break;
    }
    try {
      inherited ??= new Socket({ fd: 3, readable: true, writable: true });
      const result = await new Promise((resolve, reject) => {
        const url = new URL(endpoint);
        url.pathname = `/v1/fleet/seats/${encodeURIComponent(command.pane)}/messages`;
        const req = request(
          url,
          { createConnection: () => inherited, headers: { "x-clankie-pane": command.pane } },
          (response) => {
            let body = "";
            response.setEncoding("utf8");
            response.on("data", (chunk) => {
              body += chunk;
            });
            response.on("end", () => resolve({ status: response.statusCode, ...JSON.parse(body) }));
          },
        );
        req.on("error", reject);
        req.setTimeout(5_000, () => req.destroy(new Error("Heir request timed out")));
        req.end();
      });
      control.write(JSON.stringify({ id: command.id, ...result }) + "\n");
    } catch (error) {
      control.write(JSON.stringify({ id: command.id, transportError: String(error) }) + "\n");
    }
  }
}
