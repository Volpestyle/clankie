# ADR 0195: Hosted requests fit the model proxy

Status: accepted (lead, 2026-09-26; the 250k threshold is James's call). Tracks
[VUH-1371](https://linear.app/vuhlp/issue/VUH-1371).

## Context

The fleet model proxy refuses a request body over 2 MiB. Pi compacts a session
only near the model's context window minus a 16k reserve, and the pinned
included-usage models are far larger than 2 MiB of text. So a long hosted
session on included usage would fail on every call before Pi ever compacted it.
Images and outsized tool output make it worse: they are bytes that a token
count does not bound, so a short session with a few photos can pass the limit
too.

The cost-floor study on the same issue also measured two cheaper fixes. Pi keys
OpenAI's prompt cache by session, so every new conversation, room and wake
started cold even with a byte-identical prefix. And a hosted body offered tools
whose service it does not run.

## Decision

1. **A compaction threshold.** `compact_at_tokens` in `clankie.json` sets the
   context size at which a captain session compacts. Unset, included usage
   (provider `clankie`) compacts at 250,000 tokens (about 1 MiB of text), and
   other models keep their own window. Set, it applies to every model. The
   session's model window is narrowed to the threshold plus Pi's reserve, so Pi's
   own compaction does the work. `clankie model compaction` and `/compaction`
   configure it.
   - 250k over the 64k the cost study found cheapest: James prefers rare
     compaction. At the study's modelled months this costs about $0.38 more a
     Starter month and $3.1 more a Pro month, well inside both allowances.
2. **A byte guard on included usage.** Every request is measured before it is
   sent. Over 90% of the proxy's limit (about 1.8 MiB), older images become a
   one-line note, then older outsized tool outputs keep only their head and
   tail, then the newest outsized output does. The newest message's images stay.
   A trimmed run compacts before the session's next run, while it is idle;
   compacting from inside a run would refuse a turn that arrived meanwhile.
3. **One prompt cache key per install and lane.** Metered OpenAI-family
   requests carry `clankie-<install salt>-<lane>` instead of the session id, so
   a new conversation starts on the cached prefix. 24-hour retention is asked
   for only on the models OpenAI lists for it; GPT-5.6 and later (luna
   included) keep a prefix for 30 minutes and are not on the list. The
   subscription transport is left as Pi builds it.
4. **Tools follow the loadout.** Voice, music and screen-share tools need a
   live Discord body. When the image's `CLANKIE_SERVICES` loadout runs none (a
   hosted body runs `clankie,relay`), those tools are not offered.

## Consequences

- A long hosted session compacts near 250k and never sends a request the proxy
  refuses, unless the newest message alone is too large; that one is sent and
  the proxy's refusal names it.
- A trimmed image is gone from that request. He sees a note saying so, not the
  picture.
- Compaction after trimming can be refused by Pi when the bytes were images
  (Pi estimates an image at about 1,200 tokens). The guard alone still keeps
  each request under budget.
- Measured on gpt-6-luna: a new conversation's first turn went from 0 cached
  (9,038 written) to 9,037 cached; the hosted tool list from 34 tools (10,524
  prompt tokens) to 21 (9,037); after compaction at 250k, recall of four
  planted facts stayed 4/4.
