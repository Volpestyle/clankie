/** Real body process: stop must be explicitly allowed and acknowledged by its host. */
import { createServer } from "node:http";
let allowed = false;
const server = createServer((request, response) => {
  if (request.url === "/allow-stop") {
    allowed = true;
    response.writeHead(200).end("ready");
    return;
  }
  if (request.url === "/stop") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ stopped: allowed }));
    if (allowed) server.close(() => process.exit(0));
    return;
  }
  response.writeHead(200).end("busy");
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
process.send?.({ port: (server.address() as { port: number }).port });
process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("disconnect", () => server.close(() => process.exit(0)));
