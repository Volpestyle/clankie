# apps/clankie/src/captain/lane-log.ts

`LaneLog` stores bounded heard/said JSONL per room (`<lane>~<encoded target>.jsonl`) and projects it directly into protocol `ObservableCaptainLane` records. `append`, `read`, and `list` feed both `observe_room` and the TUI lane view; malformed lines/files are skipped and reads are tail-bounded.
