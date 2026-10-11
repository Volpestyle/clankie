/** Read-only native app discovery, also executed on the selected remote host.
 * No thread/model turn or owner configuration edit occurs.
 */
export const CODEX_APP_CATALOG_PROGRAM = String.raw`
const { spawn } = require('node:child_process');
// Windows installations expose codex.cmd (including the selected-account wrapper),
// rather than a codex.exe on PATH. Only this fixed command crosses cmd.exe.
const child = process.platform === 'win32'
  ? spawn('cmd.exe', ['/d', '/s', '/c', 'codex app-server --stdio'], { stdio: ['pipe', 'pipe', 'pipe'] })
  : spawn('codex', ['app-server', '--stdio'], { stdio: ['pipe', 'pipe', 'pipe'] });
let stderr = '';
child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-8192); });
let sequence = 0, buffer = '', failure;
const pending = new Map();
const fail = (error) => { failure ??= error; for (const entry of pending.values()) entry.reject(error); pending.clear(); };
child.on('error', fail);
child.on('close', (code, signal) => fail(new Error('Codex app catalog process exited (' + (signal ?? code) + ')' + (stderr.trim() ? ': ' + stderr.trim() : ''))));
child.stdin.on('error', fail);
child.stdout.on('data', (chunk) => {
  buffer += chunk.toString();
  // Native directory notifications observed during initialization are ~6.9 MB,
  // even though we read only installed runtime metadata (VUH-1952).
  if (buffer.length > 16 * 1024 * 1024) return fail(new Error('Codex app catalog frame too large'));
  while (buffer.includes('\n')) {
    const end = buffer.indexOf('\n'), line = buffer.slice(0, end);
    buffer = buffer.slice(end + 1);
    let message;
    try { message = JSON.parse(line); } catch { fail(new Error('Invalid Codex app catalog frame')); continue; }
    const entry = pending.get(message.id);
    if (!entry) continue;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error('Codex app catalog ' + entry.method + ' failed: ' + JSON.stringify(message.error)));
    else entry.resolve(message.result);
  }
});
const request = (method, params) => new Promise((resolve, reject) => {
  if (failure) return reject(failure);
  const id = ++sequence;
  pending.set(id, { resolve, reject, method });
  child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
});
const timer = setTimeout(() => { fail(new Error('Codex app catalog timed out')); child.kill(); }, 30000);
(async () => {
  try {
    await request('initialize', { clientInfo: { name: 'clankie-tracker-discovery', version: '1' }, capabilities: { experimentalApi: true } });
    child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
    const installed = await request('app/installed', { forceRefresh: true });
    if (!Array.isArray(installed?.apps)) throw new Error('Invalid Codex installed app catalog');
    const apps = installed.apps.map((app) => {
      if (typeof app.id !== 'string' || !app.id || typeof app.enabled !== 'boolean' || typeof app.callable !== 'boolean' || (app.runtimeName !== null && typeof app.runtimeName !== 'string')) throw new Error('Invalid Codex installed app');
      if (app.callable && !app.runtimeName) throw new Error('Callable Codex app has no runtime name');
      return { id: app.id, name: app.runtimeName ?? '', isEnabled: app.enabled };
    });
    process.stdout.write(JSON.stringify(apps));
  } catch (error) {
    process.stderr.write(error.message + '\n');
    process.exitCode = 1;
  } finally {
    // Closing stdin lets the launcher and app-server drain together on Windows.
    // Killing cmd.exe here would leave its native Codex child behind.
    child.stdin.end();
    if (child.exitCode !== null) clearTimeout(timer);
    else child.once('close', () => clearTimeout(timer));
  }
})();
`;

/** IDs are discovered by name, never assumed to be universal across accounts. */
export function codexTrackerAppOverrides(stdout: string): string[] {
  const apps: unknown = JSON.parse(stdout);
  if (!Array.isArray(apps)) throw new Error("Codex listed its apps in an unexpected shape");
  const ids = new Set<string>();
  for (const app of apps) {
    if (
      typeof app?.id !== "string" ||
      !app.id ||
      typeof app.name !== "string" ||
      typeof app.isEnabled !== "boolean"
    )
      throw new Error("Codex listed an invalid app");
    if (/\blinear\b/iu.test(app.name)) {
      // Use bare path segments: a quoted-ID override did not disable Linear
      // in native proof, while the same discovered ID without quotes did.
      if (!/^[A-Za-z0-9_-]+$/u.test(app.id)) throw new Error("Codex Linear app has an unsupported ID");
      ids.add(app.id);
    }
  }
  // Even disabled entries receive the override: it must beat a different
  // project/default value when the native TUI loads its workspace.
  return [...ids].sort().map((id) => `apps.${id}.enabled=false`);
}
