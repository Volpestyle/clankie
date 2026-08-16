# apps/clankie/test/app-smoke.test.ts

One boot-to-first-answer pass over the merged
service with a stub captain and temp dirs:
health, a Discord channel turn, an episode
write + recall, and the operator-conversation
dispatch path. Pins the fix that the dispatch
route takes the shared captain token (it once
checked the operator credential and 401'd every
real caller); unauthenticated dispatch still
401s.
