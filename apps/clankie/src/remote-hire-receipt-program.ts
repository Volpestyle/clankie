/** Literal host program: bundlers must not capture transpiler helpers in remote code. */
export const REMOTE_HIRE_RECEIPT_PROGRAM = String.raw`function hostOperation(request) {
    const fs = require("node:fs");
    const path = require("node:path");
    const os = require("node:os");
    const crypto = require("node:crypto");
    const child = require("node:child_process");
    const { isDeepStrictEqual } = require("node:util");
    const digest = (value) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
    const { claim } = request;
    const directory = path.join(os.homedir(), ".clankie", "hire-receipts");
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(directory).isSymbolicLink())
        throw new Error("Hire receipt directory is a symlink");
    const file = path.join(directory, digest([claim.target, claim.receiptKey, claim.receiptId]) + ".json");
    const lock = file + ".lock";
    // A lost SSH operation can leave a lock. Never guess that its owner is dead or steal it.
    fs.mkdirSync(lock, { mode: 0o700 });
    try {
        const identity = digest([os.hostname(), os.platform(), os.userInfo().username]);
        const read = () => {
            const stat = fs.lstatSync(file,{bigint:true});
            if (!stat.isFile() || stat.isSymbolicLink())
                throw new Error("Invalid host receipt file");
            const record = JSON.parse(fs.readFileSync(file, "utf8"));
            if (!isDeepStrictEqual(record.claim, claim) ||
                record.hostIdentity !== identity ||
                !Number.isSafeInteger(record.openedAt) ||
                record.openedAt < 0 ||
                !["reserved", "launching", "sealed", "recovered"].includes(record.state))
                throw new Error("Host receipt identity or history changed");
            return record;
        };
        const write = (record, initial = false) => {
            const temporary = file + "." + crypto.randomUUID() + ".tmp";
            const descriptor = fs.openSync(temporary, "wx", 0o600);
            try {
                fs.writeFileSync(descriptor, JSON.stringify(record));
                fs.fsyncSync(descriptor);
            }
            finally {
                fs.closeSync(descriptor);
            }
            if (initial && fs.existsSync(file))
                throw new Error("Original host receipt already exists");
            fs.renameSync(temporary, file);
            if (process.platform !== "win32") {
                const parent = fs.openSync(directory, "r");
                try {
                    fs.fsyncSync(parent);
                }
                finally {
                    fs.closeSync(parent);
                }
            }
        };
        if (request.op === "reserve") {
            // Repeating admission reads the same reservation; it never grants a launch twice.
            if (fs.existsSync(file)) {
                if (read().state !== "reserved")
                    throw new Error("Original host receipt is already launch-fenced or sealed");
            }
            else
                write({ claim, hostIdentity: identity, openedAt: Date.now(), state: "reserved" }, true);
            return { reserved: true };
        }
        const unknownRecovery = request.op === "recover" && request.recovery?.disposition === "abandoned-unknown";
        if (unknownRecovery && !fs.existsSync(file))
            throw new Error("Unknown abandonment requires the existing original launch journal");
        const record = request.op === "recover" && !fs.existsSync(file)
            ? { claim, hostIdentity: identity, openedAt: Date.now(), state: "recovered" } : read();
        if (request.op === "launch") {
            if (record.state !== "reserved")
                throw new Error("Original host receipt cannot launch again");
            write({ ...record, state: "launching" });
            return { launchCommitted: true };
        }
        if (request.op !== "recover" && record.state === "sealed" && record.evidence)
            return record.evidence;
        if (request.op !== "recover" && record.state !== "reserved")
            throw new Error("Host history crossed the launch boundary");
        const priorUnknown = record.recoveries?.at(-1);
        if (priorUnknown?.request?.disposition === "abandoned-unknown" &&
            (!unknownRecovery || !isDeepStrictEqual(priorUnknown.request, request.recovery)))
            throw new Error("Original unknown abandonment has a different retained disposition");
        if (unknownRecovery &&
            ((record.state !== "launching" && !(record.state === "recovered" && priorUnknown?.request?.disposition === "abandoned-unknown")) ||
                request.recovery.paneId !== undefined || request.recovery.message !== undefined || request.recovery.beforeIds !== undefined))
            throw new Error("Unknown abandonment requires unmapped original launching history");
        if (unknownRecovery) {
            const originalKey = JSON.parse(claim.receiptKey);
            if (!Array.isArray(originalKey) || originalKey[0] !== claim.target.fleet ||
                originalKey[1] !== "codex" || originalKey[2] !== request.recovery.cwd || originalKey[3] !== "new" || request.recovery.harness !== "codex")
                throw new Error("Unknown abandonment requires the exact fresh Codex launch identity");
        }
        const run = (program, argv) => child.execFileSync(program, argv, {
            encoding: "utf8",
            timeout: 15_000,
            maxBuffer: 16 * 1024 * 1024,
        });
        const inventory = (verb, field) => {
            const result = JSON.parse(run("herdr", ["--session", claim.target.session, verb, "list"]));
            const entries = result.result?.[field];
            if (result.error || !Array.isArray(entries))
                throw new Error("Incomplete " + verb + " census");
            return entries;
        };
        const panes = inventory("pane", "panes");
        const agents = inventory("agent", "agents");
        if (panes.some((entry) => typeof entry.pane_id !== "string") ||
            agents.some((entry) => typeof entry.pane_id !== "string" || !panes.some((pane) => pane.pane_id === entry.pane_id)))
            throw new Error("Pane/session census changed or is incomplete");
        const processes = process.platform === "win32"
            ? JSON.parse(run("powershell.exe", [
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "$ErrorActionPreference='Stop'; @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate) | ConvertTo-Json -Compress",
            ]))
            : run("ps", ["-axo", "pid=,ppid=,lstart=,comm="]).trim().split("\n");
        if (!Array.isArray(processes) || processes.length === 0)
            throw new Error("Incomplete process census");
        const validProcesses = process.platform === "win32"
            ? processes.every((entry) => Number.isSafeInteger(entry.ProcessId) &&
                Number(entry.ProcessId) >= 0 &&
                Number.isSafeInteger(entry.ParentProcessId) &&
                Number(entry.ParentProcessId) >= 0 &&
                ([0, 4].includes(Number(entry.ProcessId)) ||
                    (typeof entry.CreationDate === "string" && entry.CreationDate.length > 0)))
            : processes.every((entry) => typeof entry === "string" &&
                /^\s*\d+\s+\d+\s+\S+\s+\S+\s+\d+\s+[\d:]+\s+\d{4}\s+\S/u.test(entry));
        if (!validProcesses)
            throw new Error("Incomplete process identity census");
        const finalPanes = inventory("pane", "panes");
        if (digest(panes.map((pane) => [pane.pane_id,pane.terminal_id,pane.agent_session]).sort()) !==
            digest(finalPanes.map((pane) => [pane.pane_id,pane.terminal_id,pane.agent_session]).sort()))
            throw new Error("Pane census changed during observation");

        if (request.op === "recover") {
            const recovery = request.recovery;
            if (!recovery || !["delivered", "abandoned", "abandoned-unknown"].includes(recovery.disposition))
                throw new Error("Invalid recovery disposition");
            if (!unknownRecovery && (typeof recovery.paneId !== "string" || !recovery.paneId.startsWith(claim.target.fleet + "/") || recovery.paneId.length <= claim.target.fleet.length + 1))
                throw new Error("Original recovery allocation is incomplete");
            const rawPane = unknownRecovery ? undefined : recovery.paneId.slice(claim.target.fleet.length + 1);
            const allocationPane = panes.find(pane => pane.pane_id === rawPane);
            const allocation = { paneId: recovery.paneId, present: !!allocationPane,
                ...(allocationPane ? { terminalId: claim.target.fleet + "/" + allocationPane.terminal_id,
                    ...(allocationPane.agent_session?.value ? {sessionId: allocationPane.agent_session.value} : {}),
                    status: allocationPane.agent_status } : {}) };
            let delivery;
            if (recovery.disposition === "delivered") {
                if (recovery.harness !== "claude" || !recovery.message || !Array.isArray(recovery.beforeIds))
                    throw new Error("Original channel receipt/history is incomplete");
                const projects = path.join(os.homedir(), ".claude", "projects");
                const projectsRoot = fs.realpathSync(projects);
                const snapshotIdentity = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs];
                // Windows path stats report dev=0; handles report the volume. Keep exact
                // bigint file IDs and compare volume only handle-to-handle.
                const pathIdentity = stat => process.platform === "win32" ? snapshotIdentity(stat).slice(1) : snapshotIdentity(stat);
                const confined = file => {
                    const part = path.relative(projectsRoot, fs.realpathSync(file));
                    if (part === ".." || part.startsWith(".." + path.sep) || path.isAbsolute(part)) throw new Error("Transcript escaped its profile");
                };
                const readSnapshot = file => {
                    confined(file);
                    const initial = fs.lstatSync(file,{bigint:true});
                    if (!initial.isFile() || initial.isSymbolicLink()) throw new Error("Invalid transcript file");
                    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
                    try {
                        const stat = fs.fstatSync(fd,{bigint:true});
                        if (!stat.isFile() || !isDeepStrictEqual(pathIdentity(initial), pathIdentity(stat)) || stat.size > 32 * 1024 * 1024 || (totalBytes += Number(stat.size)) > 256 * 1024 * 1024) throw new Error("Transcript snapshot changed or exceeds recovery bound");
                        const buffer = Buffer.alloc(Number(stat.size));
                        let offset = 0;
                        while (offset < buffer.length) {const read = fs.readSync(fd,buffer,offset,buffer.length-offset,offset);if (!read) throw new Error("Transcript snapshot truncated");offset += read;}
                        if (fs.readSync(fd,Buffer.alloc(1),0,1,offset) !== 0 || !isDeepStrictEqual(snapshotIdentity(stat),snapshotIdentity(fs.fstatSync(fd,{bigint:true})))) throw new Error("Transcript changed during bounded read");
                        confined(file);
                        const current = fs.lstatSync(file,{bigint:true});
                        if (current.isSymbolicLink() || !isDeepStrictEqual(pathIdentity(stat),pathIdentity(current))) throw new Error("Transcript path changed during read");
                        return {content:buffer.toString("utf8"),stat};
                    } finally {fs.closeSync(fd);}
                };
                const candidates = [];
                let count = 0, totalBytes = 0;
                const normalizeCwd = value => (process.platform === "win32" ? path.win32.normalize(value).toLowerCase() : path.resolve(value));
                const collect = directory => {
                    if (fs.lstatSync(directory).isSymbolicLink()) throw new Error("Transcript directory is redirected");
                    for (const entry of fs.readdirSync(directory, {withFileTypes:true})) {
                        const current = path.join(directory, entry.name);
                        if (entry.isSymbolicLink()) throw new Error("Transcript inventory contains a symlink");
                        if (entry.isDirectory()) { collect(current); continue; }
                        if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
                        if (++count > 4096) throw new Error("Transcript inventory exceeds recovery bound");
                        // Sidechain files cannot prove a main-session channel delivery.
                        if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.jsonl$/u.test(entry.name)) continue;
                        const {content,stat} = readSnapshot(current);
                        // Inspect only files containing this exact original UUID; parse every line in that file.
                        if (!content.includes(recovery.message.receiptId)) continue;
                        if (!content.endsWith("\n")) throw new Error("Original transcript is incomplete");
                        const rows = content.trimEnd().split("\n").map(line => JSON.parse(line));
                        for (const row of rows) {
                            if (row.type !== "user" || row.message?.role !== "user" || typeof row.message.content !== "string") continue;
                            const text = row.message.content;
                            const taggedId = /^<channel ([^>]+)>/u.exec(text)?.[1];
                            if (!taggedId || ![...taggedId.matchAll(/event_id="([^"<>]*)"/gu)].some(attr => attr[1] === recovery.message.receiptId)) continue;
                            if (row.isSidechain !== false || row.isMeta !== true || row.promptSource !== "system" || row.origin?.kind !== "channel" || row.origin.server !== "plugin:clankie-worker:clankie")
                                throw new Error("Original event lacks native channel origin");
                            const outer = /^<channel ([^>]+)>\r?\n([\s\S]*)\r?\n<\/channel>$/u.exec(text);
                            if (!outer || /<\/?channel\b/u.test(outer[2])) throw new Error("Original event channel body is incomplete or ambiguous");
                            const attrs = [...outer[1].matchAll(/([a-z_]+)="([^"<>]*)"/gu)];
                            if (attrs.map(attr => attr[0]).join(" ") !== outer[1]) throw new Error("Invalid channel attributes");
                            const values = name => attrs.filter(attr => attr[1] === name).map(attr => attr[2]);
                            for (const name of ["event_id", "conversation", "kind", "created_at"])
                                if (values(name).length !== 1) throw new Error("Ambiguous channel attributes");
                            if (values("event_id")[0] !== recovery.message.receiptId || values("conversation")[0] !== recovery.message.seatId || values("kind")[0] !== "message" || !isDeepStrictEqual(values("source"),["plugin:clankie-worker:clankie","captain"]))
                                throw new Error("Original channel recipient changed");
                            const fingerprint = crypto.createHash("sha256").update(outer[2].replace(/\r\n?/gu,"\n").trim()).digest("hex");
                            if (fingerprint !== claim.fingerprint || normalizeCwd(row.cwd) !== normalizeCwd(recovery.cwd) || row.sessionId + ".jsonl" !== entry.name || (recovery.beforeIds.includes(row.uuid) || recovery.beforeIds.includes("claude:" + row.uuid)) || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(row.uuid) || !Number.isFinite(Date.parse(row.timestamp)))
                                throw new Error("Original native event identity or content changed");
                            candidates.push({ receiptId: recovery.message.receiptId, seatId: recovery.message.seatId,
                                sessionId: row.sessionId, entryId: row.uuid, at: row.timestamp,
                                transcriptSha256: crypto.createHash("sha256").update(content).digest("hex"), binding: "historical-native-event" });
                        }
                        confined(current);
                        const finalStat = fs.lstatSync(current,{bigint:true});
                        if (finalStat.isSymbolicLink() || !isDeepStrictEqual(pathIdentity(stat),pathIdentity(finalStat))) throw new Error("Original transcript changed during recovery");
                    }
                };
                const nativeCwd = process.platform === "win32" ? path.win32.normalize(recovery.cwd) : path.resolve(recovery.cwd);
                const project = path.join(projects,nativeCwd.replace(/[^a-zA-Z0-9]/gu,"-"));
                confined(project);
                collect(project);
                if (candidates.length !== 1) throw new Error("Original native delivery is absent or ambiguous");
                delivery = candidates[0];
                if (recovery.message.binding) {
                    const binding = crypto.createHash("sha256").update(JSON.stringify([recovery.paneId, recovery.message.seatId, "claude", {source:"herdr:claude",kind:"id",value:delivery.sessionId}])).digest("hex");
                    if (binding !== recovery.message.binding) throw new Error("Original native recipient binding changed");
                    delivery.binding = "original-native-binding";
                }
            }
            const after = inventory("pane", "panes");
            if (digest(panes.map(pane => [pane.pane_id,pane.terminal_id,pane.agent_session]).sort()) !== digest(after.map(pane => [pane.pane_id,pane.terminal_id,pane.agent_session]).sort())) throw new Error("Native allocation changed during recovery");
            const observedAt = Date.now();
            const proof = { receiptId: claim.receiptId, receiptKey: claim.receiptKey,
                fingerprint: claim.fingerprint, target: claim.target, hostIdentity: identity,
                census: { observedAt, panes: panes.length, processes: processes.length,
                    sessions: agents.filter(agent => agent.agent_session != null).length,
                    sha256: digest([panes,agents,processes]) },
                journal: "authenticated-recovery", disposition: recovery.disposition,
                allocation: unknownRecovery ? {outcome:"unknown", launchHistory:"launching",
                    openedAt:record.openedAt, abandonedAt:observedAt, freshIntentAllowed:true} : allocation,
                ...(delivery ? {delivery} : {}) };
            write({...record, state:"recovered", recoveries:[...(record.recoveries ?? []),{request:recovery,evidence:proof}]}, !fs.existsSync(file));
            return proof;
        }
        // The reserved journal covers the entire interval: every authorized effect needs launch CAS.
        // Absence from a live listing alone is never sufficient and cannot recover legacy records.
        const observedAt = Date.now();
        const evidence = {
            receiptId: claim.receiptId,
            receiptKey: claim.receiptKey,
            fingerprint: claim.fingerprint,
            target: claim.target,
            hostIdentity: identity,
            window: { openedAt: record.openedAt, sealedAt: observedAt },
            census: {
                observedAt,
                panes: panes.length,
                processes: processes.length,
                sessions: agents.filter((agent) => agent.agent_session !== undefined && agent.agent_session !== null)
                    .length,
                sha256: digest([panes, agents, processes]),
            },
            journal: "reserved-to-sealed-without-launch",
        };
        write({ ...record, state: "sealed", evidence });
        return evidence;
    }
    finally {
        fs.rmdirSync(lock);
    }
}`;
