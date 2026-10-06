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
            const stat = fs.lstatSync(file);
            if (!stat.isFile() || stat.isSymbolicLink())
                throw new Error("Invalid host receipt file");
            const record = JSON.parse(fs.readFileSync(file, "utf8"));
            if (!isDeepStrictEqual(record.claim, claim) ||
                record.hostIdentity !== identity ||
                !Number.isSafeInteger(record.openedAt) ||
                record.openedAt < 0 ||
                !["reserved", "launching", "sealed"].includes(record.state))
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
        const record = read();
        if (request.op === "launch") {
            if (record.state !== "reserved")
                throw new Error("Original host receipt cannot launch again");
            write({ ...record, state: "launching" });
            return { launchCommitted: true };
        }
        if (record.state === "sealed" && record.evidence)
            return record.evidence;
        if (record.state !== "reserved")
            throw new Error("Host history crossed the launch boundary");
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
        if (digest(panes.map((pane) => pane.pane_id).sort()) !==
            digest(finalPanes.map((pane) => pane.pane_id).sort()))
            throw new Error("Pane census changed during observation");
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
