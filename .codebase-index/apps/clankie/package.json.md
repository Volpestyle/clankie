# apps/clankie/package.json

Manifest for the private ESM `@clankie/clankie` service (`0.2.0`). Dev/start/free-play run TypeScript directly with `tsx`; build/typecheck use `tsc --noEmit`, and tests use Vitest.

It composes the workspace protocol, credentials, settings, model/media, environment, body-lock, voice, rendered-surface and observability packages with Pi `0.84.2`, Hono, TypeBox/Zod, plus `imapflow` and `nodemailer` for connected email.
