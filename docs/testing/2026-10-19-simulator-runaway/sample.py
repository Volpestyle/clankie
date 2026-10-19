"""Bounded per-process sampler for ONE leased simulator. Read-only.
usage: python3 -I sample.py HELPER UDID SECONDS INTERVAL OUT.jsonl"""
import json, subprocess, sys, time, re, collections
helper, udid, seconds, interval, out = sys.argv[1], sys.argv[2].upper(), float(sys.argv[3]), float(sys.argv[4]), sys.argv[5]
prev = None; prev_at = None; seen = set()
end = time.time() + seconds
with open(out, "a") as f:
    while time.time() < end:
        t0 = time.time()
        try:
            rep = json.loads(subprocess.run(["/usr/bin/python3", "-I", helper, "simulator-usage"], capture_output=True, timeout=5, check=True).stdout)
        except Exception as e:
            f.write(json.dumps({"at": t0, "error": type(e).__name__}) + "\n"); f.flush(); time.sleep(interval); continue
        load = subprocess.run(["/usr/sbin/sysctl", "-n", "vm.loadavg"], capture_output=True, text=True).stdout.split()[1:4]
        mp = subprocess.run(["/usr/bin/memory_pressure", "-Q"], capture_output=True, text=True).stdout
        m = re.search(r"(\d+)%", mp)
        dev = next((d for d in rep["devices"] if d["deviceId"].upper() == udid), None)
        row = {"at": rep["sampledAtMs"], "load1": float(load[0]), "freePct": int(m.group(1)) if m else None}
        if dev:
            procs = {f'{p["pid"]}:{p["startTime"]}': p for p in dev["processes"]}
            dt = (rep["sampledAtMs"] - prev_at) if prev_at else None
            cpu = {}
            new = 0
            for k, p in procs.items():
                if prev is not None:
                    if k in prev: cpu[k] = max(0, p["cpuTimeMs"] - prev[k]["cpuTimeMs"])
                    else:
                        new += 1
                        cpu[k] = p["cpuTimeMs"] if float(p["startTime"]) * 1000 >= prev_at else 0
            byname = collections.defaultdict(lambda: [0.0, 0, 0])
            for k, p in procs.items():
                b = byname[p["executable"]]; b[0] += cpu.get(k, 0); b[1] += p["footprintBytes"]; b[2] += 1
            row.update({"rootPid": dev["rootPid"], "n": len(procs), "unavail": dev["unavailableProcesses"],
                        "footGiB": round(sum(p["footprintBytes"] for p in procs.values()) / 2**30, 2),
                        "new": new, "exited": (len(set(prev) - set(procs)) if prev is not None else None)})
            if dt:
                row["cpuPct"] = round(sum(cpu.values()) / dt * 100, 1)
                row["topCpu"] = [[n, round(v[0] / dt * 100, 1), v[2]] for n, v in sorted(byname.items(), key=lambda kv: -kv[1][0])[:12]]
            row["topFoot"] = [[n, round(v[1] / 2**30, 2), v[2]] for n, v in sorted(byname.items(), key=lambda kv: -kv[1][1])[:12]]
            prev, prev_at = procs, rep["sampledAtMs"]
        else:
            row["device"] = "absent"; prev = None; prev_at = None
        f.write(json.dumps(row) + "\n"); f.flush()
        time.sleep(max(0, interval - (time.time() - t0)))
