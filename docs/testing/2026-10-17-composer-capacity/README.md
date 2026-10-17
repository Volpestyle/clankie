# VUH-1571: the body's composer upload limits

[Composer transcription](../../composer-transcription.md) documents three limits
on new cloud uploads: eight at once across the machine, two at once per device,
and six starts per device per minute. The body enforced them in
`ComposerTranscription.begin`, but no test covered them. This adds that proof;
no runtime code changed.

## Check

`apps/clankie/test/composer-transcription.test.ts` gains "bounds new uploads per
device, per minute and machine-wide before any provider spend, and frees them on
cancel or after a minute". It runs on the real paired body over HTTP, with each
device using its own session, plus one request through the encrypted app
transport:

- **Per device.** A third concurrent upload gets `429 capacity`. Cancelling an
  upload frees its slot.
- **Per minute.** A seventh start in the same minute is refused, and cancelled
  starts count toward the six. A refusal does not extend the window: one
  millisecond short of the minute is still refused, and the minute itself is
  admitted.
- **Machine-wide.** Eight uploads across four devices refuse a fifth device until
  one upload ends.
- **No spend.** The fixture provider is never called.

Result: [10/10 in the file](composer-http.txt). Mutation check: raising any one of
the three limits by one fails the case. `apps/clankie` typecheck and oxfmt pass.
The fixture provider is local; no real provider, account or spend was used.

The companion app turns this refusal into its own retry copy:
clankie-app `docs/testing/2026-10-17-composer-capacity-refusal/`.
