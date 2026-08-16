# apps/clankie/test/voice-receipt-activity.test.ts

Tests voice receipt projection into recent speech and current-stay aggregates. Missing logs return empty, spoken/suppressed counts and tokens accumulate for an open stay, and a leave receipt closes it.
