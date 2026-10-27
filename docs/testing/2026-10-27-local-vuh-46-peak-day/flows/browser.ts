// Bundled with the two unmodified source modules from the pinned app checkout.
import { createWorkSyncPool } from "proof-app-pool";
import { createIndexedDBWorkSyncStorage } from "proof-app-storage";

const seen: { cursor: number; at: number }[] = [];
const requests: { action: string; at: number; waitMs?: number }[] = [];
let pool: ReturnType<typeof createWorkSyncPool>;
Object.assign(window, {
  start: async (token: string) => {
    pool = createWorkSyncPool({
      identity: "peak-day-scratch-web",
      storage: createIndexedDBWorkSyncStorage(),
      canWrite: () => false,
      requestId: () => crypto.randomUUID(),
      transport: {
        async sync(command, signal) {
          requests.push({
            action: command.action,
            at: Date.now(),
            ...(command.action === "subscribe" ? { waitMs: command.waitMs } : {}),
          });
          const response = await fetch("/sync", {
            method: "POST",
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            body: JSON.stringify(command),
            signal,
          });
          if (!response.ok) throw new Error(await response.text());
          return response.json();
        },
        async answer() {
          throw new Error("No owner answers in this proof");
        },
      },
    });
    pool.subscribe(() => {
      const snapshot = pool.getSnapshot();
      if (snapshot.lastSyncId !== undefined && seen.at(-1)?.cursor !== snapshot.lastSyncId)
        seen.push({ cursor: snapshot.lastSyncId, at: Date.now() });
      document.querySelector("pre")!.textContent = JSON.stringify(
        {
          cursor: snapshot.lastSyncId,
          models: snapshot.models.length,
          ready: snapshot.ready,
          error: snapshot.error,
          requests: requests.length,
        },
        null,
        2,
      );
    });
    void pool.connect(["*"]).catch((error) => {
      document.querySelector("pre")!.textContent += String(error);
    });
  },
  snapshot: () => pool.getSnapshot(),
  capture: () => ({ seen, requests, snapshot: pool.getSnapshot() }),
  stop: () => pool.stop(),
});
