/** Bundle the actual installed WS implementation into a protected native proxy. */
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { writeFileSync, lstatSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export async function buildNativeProxy({
  output,
  allocationId,
  cwd,
  profile,
  model,
  effort,
  upstream,
  socketPath,
}) {
  const parent = dirname(output),
    stat = lstatSync(parent);
  if (realpathSync(parent) !== parent || stat.uid !== process.getuid() || stat.mode & 0o077)
    throw Error("Private proxy build output required");
  const modulePath = fileURLToPath(new URL("./lead-native-proxy.mjs", import.meta.url));
  const input = { allocationId, cwd, profile, model, effort };
  const contents = `
import WebSocket, {WebSocketServer} from "ws";
import {NativeRequestPolicy,NativeDecisionPipe,serveNativeProxy} from ${JSON.stringify(modulePath)};
const policy=new NativeRequestPolicy(${JSON.stringify(input)});
let proxy;
const failed=async(error)=>{process.stderr.write(String(error)+"\\n"); process.exitCode=1;process.stdin.destroy();process.stdout.end();};
const decisions=new NativeDecisionPipe({readable:process.stdin,writable:process.stdout,allocationId:${JSON.stringify(allocationId)},failed:async(error)=>{if(proxy)await proxy.close();else await failed(error);}});
const connect=()=>new Promise((resolve,reject)=>{const ws=new WebSocket(${JSON.stringify(`ws+unix://${upstream}:/`)});ws.once("open",()=>resolve(ws));ws.once("error",reject);});
proxy=await serveNativeProxy({WebSocketServer,connect,socketPath:${JSON.stringify(socketPath)},policy,decisions,failed});
process.stdout.write(JSON.stringify({ready:true,allocationId:${JSON.stringify(allocationId)},socketPath:${JSON.stringify(socketPath)}})+"\\n");
`;
  const result = await build({
    stdin: {
      contents,
      resolveDir: resolve(dirname(modulePath), "../../apps/clankie"),
      sourcefile: "lead-native-proxy-entry.mjs",
      loader: "js",
    },
    bundle: true,
    write: false,
    platform: "node",
    target: "node24",
    format: "esm",
    banner: {
      js: 'import { createRequire as __createRequire } from "node:module";const require=__createRequire(import.meta.url);',
    },
  });
  if (result.outputFiles.length !== 1) throw Error("Ambiguous native proxy bundle");
  const bytes = result.outputFiles[0].contents;
  writeFileSync(output, bytes, { flag: "wx", mode: 0o500 });
  return { sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
}
