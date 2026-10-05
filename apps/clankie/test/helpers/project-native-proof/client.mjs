import { connect } from "node:net";
import { Agent, request } from "node:http";
import { createInterface } from "node:readline";
const [controlPath, name, endpoint, pane] = process.argv.slice(2);
const control = connect(controlPath);
const agent = new Agent({ keepAlive: true, maxSockets: 1 });
control.on("connect", () => control.write(JSON.stringify({ ready: name, pid: process.pid }) + "\n"));
control.on("error", () => process.exit(1));
control.on("close", () => {
  agent.destroy();
  process.exit(0);
});
for await (const line of createInterface({ input: control })) {
  const command = JSON.parse(line);
  if (command.quit) {
    agent.destroy();
    control.end();
    break;
  }
  try {
    const result = await new Promise((resolve, reject) => {
      const req = request(
        endpoint,
        { agent, method: "POST", headers: { "x-clankie-pane": command.pane ?? pane } },
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
      req.setTimeout(10_000, () => req.destroy(new Error("Project proof request timed out")));
      req.end("{}");
    });
    control.write(JSON.stringify({ id: command.id, ...result }) + "\n");
  } catch (error) {
    control.write(JSON.stringify({ id: command.id, transportError: String(error) }) + "\n");
  }
}
