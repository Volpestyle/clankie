// Stands in for a hired harness in a desktop-app terminal: it holds a TCP child, as
// Claude holds its Clankie bridge, and both stay up until stdin closes.
import { spawn } from "node:child_process";
const [port] = process.argv.slice(2);
const child = spawn(
  process.execPath,
  [
    "-e",
    `const s=require("node:net").connect(${Number(port)},"127.0.0.1");s.on("connect",()=>process.stdout.write("connected\\n"));process.stdin.on("end",()=>process.exit(0));process.stdin.resume();`,
  ],
  { stdio: ["pipe", "inherit", "inherit"] },
);
process.stdin.on("end", () => child.stdin.end());
process.stdin.resume();
