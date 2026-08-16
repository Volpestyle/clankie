# apps/clankie/test/email.test.ts

Tests the connected email port with injected IMAP/SMTP adapters. It covers missing-connection refusals, credential-backed list/read behavior, and MIME text-body extraction preferring `text/plain`.
