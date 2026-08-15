# apps/tui/test/transcript-key-routing.test.ts

The global-input routing predicate: page/wheel/alt
shortcuts route to the transcript while the prompt is
empty; with a draft only draft-safe scrolling routes
(alt shortcuts stay with the editor); nothing routes
during setup prompts or command-palette focus.
