import { spawn } from "node:child_process";
import { chmod, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@browser_use/pi";

/** Record the owned tab through public SDK screenshots, including human takeover. */
export async function startBrowserRecording(
  directory: string,
  currentPage: () => Page | undefined,
  environment: NodeJS.ProcessEnv,
): Promise<{ stop(): Promise<string> }> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${new Date().toISOString().replace(/[:.]/gu, "-")}.webm`);
  const child = spawn(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "image2pipe",
      "-framerate",
      "4/3",
      "-vcodec",
      "mjpeg",
      "-i",
      "pipe:0",
      "-an",
      "-vf",
      "scale=1280:800:force_original_aspect_ratio=decrease,pad=1280:800:(ow-iw)/2:(oh-ih)/2",
      "-c:v",
      "libvpx-vp9",
      "-deadline",
      "realtime",
      "-cpu-used",
      "8",
      "-y",
      path,
    ],
    { env: { PATH: environment.PATH ?? "" }, stdio: ["pipe", "ignore", "pipe"] },
  );
  let error: string | undefined;
  let captureError: string | undefined;
  child.on("error", (cause) => {
    error = cause.message;
  });
  child.stderr.on("data", (bytes: Buffer) => {
    error = bytes.toString().slice(0, 500);
  });
  child.stdin.on("error", (cause) => {
    error = cause.message;
  });
  const exited = new Promise<number | null>((resolve) => child.once("close", resolve));
  let pending: Promise<void> | undefined;
  let stopped = false;
  const capture = () => {
    if (stopped || pending || child.stdin.destroyed || child.stdin.writableNeedDrain) return;
    const page = currentPage();
    if (!page) return;
    pending = page
      .screenshot({ quality: 70 })
      .then((bytes) => {
        if (!child.stdin.destroyed) child.stdin.write(bytes);
      })
      .catch((cause: unknown) => {
        // Navigations can invalidate one sample; the next interval observes again.
        captureError = cause instanceof Error ? cause.message : String(cause);
      })
      .finally(() => {
        pending = undefined;
      });
    return pending;
  };
  // Let the initial observation finish before the caller can navigate again.
  await capture();
  const timer = setInterval(() => {
    void capture();
  }, 750);
  timer.unref();
  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      await pending;
      child.stdin.end();
      const deadline = setTimeout(() => child.kill("SIGKILL"), 20_000);
      deadline.unref();
      const code = await exited;
      clearTimeout(deadline);
      if (code !== 0) {
        await rm(path, { force: true });
        throw new Error(captureError ?? error ?? `Browser recording exited with code ${String(code)}`);
      }
      await chmod(path, 0o600);
      const recordings = (await readdir(directory)).filter((name) => name.endsWith(".webm")).sort();
      for (const name of recordings.slice(0, Math.max(0, recordings.length - 50))) {
        await rm(join(directory, name), { force: true });
      }
      return path;
    },
  };
}
