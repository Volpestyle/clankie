// Bundled with the two unmodified source modules from the pinned app checkout.
import { createWorkSyncPool } from "proof-app-pool";
import { createIndexedDBWorkSyncStorage } from "proof-app-storage";

const seen: { cursor: number; at: number }[] = [];
const requests: { action: string; at: number; waitMs?: number }[] = [];
const connectionErrors: { error: string; stack?: string }[] = [];
const storageErrors: { at: number; characters: number; error: string }[] = [];
let pool: ReturnType<typeof createWorkSyncPool>;
Object.assign(window, {
  start: async (token: string) => {
    const storage = createIndexedDBWorkSyncStorage();
    pool = createWorkSyncPool({
      identity: "peak-day-scratch-web",
      storage: {
        ...storage,
        async write(identity, value) {
          try {
            await storage.write(identity, value);
          } catch (error) {
            storageErrors.push({ at: Date.now(), characters: value.length, error: String(error) });
            throw error;
          }
        },
      },
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
      connectionErrors.push({ error: String(error), stack: error?.stack });
      document.querySelector("pre")!.textContent += String(error);
    });
  },
  snapshot: () => pool.getSnapshot(),
  capture: () => ({ seen, requests, storageErrors, connectionErrors, snapshot: pool.getSnapshot() }),
  stop: () => pool.stop(),
});
