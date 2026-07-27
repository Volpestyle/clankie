/**
 * The body mutex lives in `@clankie/body-lock` so observability planes can
 * read who holds the body (VUH-938) without importing the emulator — the
 * ADR 0063 fence keeps `@clankie/gba-emulator` out of the captain and control
 * plane. Re-exported here so every existing in-package and barrel import
 * keeps working unchanged.
 */
export {
  BODY_LOCK_FILENAME,
  BodyBusyError,
  acquireBodyLock,
  observeBodyHolder,
  type AcquireBodyLockOptions,
  type BodyLock,
  type BodyLockHolder,
} from "@clankie/body-lock";
