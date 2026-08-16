# integrations/gba-emulator/test/free-play-character.test.ts

Guards the character rules: the free-play
system prompt must describe the surface
without declaring who is playing (identity is
the owner-authored character layer), and the
volition cold start — `renderView` must say
"not said anything out loud yet" before the
first remark, since hiding that signal
measurably produced total silence.
