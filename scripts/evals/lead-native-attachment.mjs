/** Controller-created native owner client; no imported 'visible' flag is accepted. */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
const PEERS = readFileSync(new URL("./lead-native-peer.py", import.meta.url), "utf8");
const SOCKET = "/eval/control/herdr.sock";
const HERDR = "/usr/local/bin/herdr";
// Read-only kernel evidence, executed by the controller outside the model sandbox.
// The immutable native binary chooses its client socket from HERDR_SOCKET_PATH.
const PROOF = `
const fs=require('node:fs'), crypto=require('node:crypto');
const [nonce,expectedHash]=process.argv.slice(1);
const sha=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const rows=[];

for(const pid of fs.readdirSync('/proc').filter(p=>/^\\d+$/.test(p))){try{
 const env=fs.readFileSync('/proc/'+pid+'/environ','utf8').split('\\0');
 if(!env.includes('LEAD_OWNER_ATTACHMENT='+nonce)||!env.includes('HERDR_SOCKET_PATH=${SOCKET}'))continue;
 const exe=fs.realpathSync('/proc/'+pid+'/exe');
 if(exe!=='${HERDR}'||sha(exe)!==expectedHash)continue;
 const argv=fs.readFileSync('/proc/'+pid+'/cmdline','utf8').split('\\0').filter(Boolean);
 if(argv.length!==2||argv[1]!=='client')continue;
 const stat=fs.readFileSync('/proc/'+pid+'/stat','utf8').split(') ').at(-1).split(' ');
 if(stat[4]==='0')continue; // tty_nr: a real native terminal, not a headless client.
 const socketInodes=fs.readdirSync('/proc/'+pid+'/fd').flatMap(fd=>{try{const link=fs.readlinkSync('/proc/'+pid+'/fd/'+fd);const id=/^socket:\\[(\\d+)\\]$/.exec(link)?.[1];return id?[Number(id)]:[]}catch{return []}});
 rows.push({pid:Number(pid),startTicks:stat[19],socketInodes});
}catch{}}
process.stdout.write(JSON.stringify(rows));`;

/** Correlate the client's actual FD inode to its kernel-reported peer and path. */
export function ownerSocketBinding(processes, sockets, expectedPath = "/eval/control/herdr-client.sock") {
  if (processes.length !== 1) return undefined;
  const process = processes[0];
  if (!Number.isSafeInteger(process.pid) || process.pid < 1 || !/^[1-9][0-9]*$/u.test(process.startTicks))
    return undefined;
  const byInode = new Map(sockets.map((row) => [row.inode, row]));
  if (byInode.size !== sockets.length || !Array.isArray(process.socketInodes)) return undefined;
  const matches = process.socketInodes.flatMap((inode) => {
    const client = byInode.get(inode),
      peer = byInode.get(client?.peer);
    return client?.state === 1 &&
      client.type === 1 &&
      peer?.state === 1 &&
      peer.type === 1 &&
      peer.peer === inode &&
      peer.path === expectedPath
      ? [
          {
            pid: process.pid,
            startTicks: process.startTicks,
            clientInode: inode,
            peerInode: peer.inode,
            peerPath: peer.path,
          },
        ]
      : [];
  });
  return matches.length === 1 ? matches[0] : undefined;
}

export class NativeOwnerAttachment {
  #child;
  #binding;
  #lost = false;
  #stopping;
  #failure;
  #nonce = randomUUID();
  constructor(container, { herdrSha256 }) {
    if (!/^[a-f0-9]{64}$/u.test(herdrSha256)) throw Error("Pinned native Herdr executable hash required");
    this.container = container;
    this.herdrSha256 = herdrSha256;
  }
  /** Called from an explicit owner CLI action only; stdin/stdout must be a TTY. */
  async attach() {
    if (this.#child) throw Error("Owner native attachment already created");
    this.#child = await this.container.attach([
      "/usr/bin/env",
      "-i",
      "PATH=/usr/local/bin:/usr/bin:/bin",
      "TERM=xterm-256color",
      "HOME=/eval/control/home",
      `HERDR_SOCKET_PATH=${SOCKET}`,
      `LEAD_OWNER_ATTACHMENT=${this.#nonce}`,
      HERDR,
      "client",
    ]);
    const lost = () => {
      this.#binding = undefined;
      this.#lost = true;
      this.#stopping ??= this.container.stop("owner native attachment lost").catch((error) => {
        this.#failure = error;
      });
    };
    this.#child.once("error", lost);
    this.#child.once("exit", lost);
    return this.#child;
  }
  async attached(containerId, socket) {
    if (
      this.#lost ||
      !this.#child ||
      this.#child.exitCode !== null ||
      this.#child.signalCode !== null ||
      containerId !== this.container.id ||
      socket !== SOCKET ||
      this.container.stopped
    )
      return false;
    const rows = JSON.parse(
      await this.container.exec([
        "/usr/bin/env",
        "-i",
        "/usr/local/bin/node",
        "-e",
        PROOF,
        this.#nonce,
        this.herdrSha256,
      ]),
    );
    if (rows.length !== 1 || !Number.isSafeInteger(rows[0].pid) || !/^\d+$/u.test(rows[0].startTicks))
      return false;
    const sockets = JSON.parse(
      await this.container.exec(["/usr/bin/env", "-i", "/usr/bin/python3", "-I", "-c", PEERS]),
    );
    await this.container.inspect();
    if (this.#stopping) await this.#stopping;
    if (this.#failure) throw this.#failure;
    if (
      this.#lost ||
      this.#child.exitCode !== null ||
      this.#child.signalCode !== null ||
      containerId !== this.container.id ||
      this.container.stopped
    )
      return false;
    const proof = ownerSocketBinding(rows, sockets);
    if (!proof) return false;
    const binding = JSON.stringify(proof);
    if (this.#binding && this.#binding !== binding) return false;
    this.#binding = binding;
    return true;
  }
}

/** Exact native TUI PID/starttime and kernel peer for one preallocated proxy. */
export async function nativeTuiBinding({ container, paneId, endpoint, cwd, codexHome, codexSha256 }) {
  if (
    !/^unix:\/\/\/eval\/control\/[a-z0-9-]+\/tui.sock$/u.test(endpoint) ||
    !/^[a-f0-9]{64}$/u.test(codexSha256)
  )
    throw Error("Pinned native process/endpoint required");
  const script = `const fs=require('node:fs'),crypto=require('node:crypto');const [pane,endpoint,cwd,home,hash]=process.argv.slice(1);const rows=[];for(const pid of fs.readdirSync('/proc').filter(p=>/^\\d+$/.test(p))){try{const env=fs.readFileSync('/proc/'+pid+'/environ','utf8').split('\\0');if(!env.includes('HERDR_PANE_ID='+pane)||!env.includes('CODEX_HOME='+home))continue;const exe=fs.realpathSync('/proc/'+pid+'/exe');if(exe!=='/opt/codex/bin/codex'||crypto.createHash('sha256').update(fs.readFileSync(exe)).digest('hex')!==hash||fs.realpathSync('/proc/'+pid+'/cwd')!==cwd)continue;const args=fs.readFileSync('/proc/'+pid+'/cmdline','utf8').split('\\0');if(args[args.indexOf('--remote')+1]!==endpoint)continue;const stat=fs.readFileSync('/proc/'+pid+'/stat','utf8').split(') ').at(-1).split(' ');if(stat[4]==='0')continue;const socketInodes=fs.readdirSync('/proc/'+pid+'/fd').flatMap(fd=>{try{const m=/^socket:\\[(\\d+)\\]$/.exec(fs.readlinkSync('/proc/'+pid+'/fd/'+fd));return m?[Number(m[1])]:[]}catch{return []}});rows.push({pid:Number(pid),startTicks:stat[19],socketInodes});}catch{}}process.stdout.write(JSON.stringify(rows));`;
  const rows = JSON.parse(
    await container.exec([
      "/usr/bin/env",
      "-i",
      "/usr/local/bin/node",
      "-e",
      script,
      paneId,
      endpoint,
      cwd,
      codexHome,
      codexSha256,
    ]),
  );
  const sockets = JSON.parse(
    await container.exec(["/usr/bin/env", "-i", "/usr/bin/python3", "-I", "-c", PEERS]),
  );
  await container.inspect();
  return ownerSocketBinding(rows, sockets, endpoint.slice("unix://".length));
}
