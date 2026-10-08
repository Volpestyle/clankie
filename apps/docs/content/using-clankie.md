# Using Clankie

Start with what you want to do. Clankie can help you think something through,
make a draft or picture, remember a preference, and bring in help for a larger
job. You do not need to learn agent terminology to talk to him.

## Everyday help

Give him a little context and the outcome you want:

- “Turn these scattered notes into a plan for the weekend.”
- “Help me draft a kind, clear reply. Here's what happened.”
- “Compare these three ideas and tell me what you would choose.”
- “Make a birthday-card picture with a sleepy robot in a garden.”

Steer him as he works: add a constraint, correct an assumption, ask for a
shorter answer. If he lacks a connection a request needs, he should say so.
Drafting a message and sending it are different requests; say which you mean.

## Memory and personality

Ask him to keep what matters: “Remember that I prefer quiet places and short
walks.” You can ask what he remembers and correct it. In the console, `/memory`
lets you browse, edit, and forget notes directly.

Memories are selected notes, separate from conversation history, and stay until
forgotten. He can search them, but memory is not a record of every message. The
[memory reference](https://github.com/Volpestyle/clankie/blob/main/docs/memory.md)
explains what each conversation and Discord room can see.

His character is his own. On a DIY installation, `/persona` shapes his name,
character, and look ([customize](/diy/#persona)).

## Making things together

Give the purpose, audience, and constraints: “Help me make a simple website for
my bakery. Start with the opening page and show me a preview before publishing
anything.”

Files he delivers stay with the conversation. Images need an image model; short
video is a separate optional capability. Renders take time, so ask what is still
running rather than starting a duplicate.

## Bigger jobs and helper agents

Clankie can do the work himself or assemble a team. Tell him the outcome, your
constraints, and the decisions you want to keep. Ask who is doing what, open a
helper's conversation, and steer as it develops.

Tell him how agents should work: “Commit and push without asking, ask me before
releases, and keep reports short.” Owner defaults apply everywhere, a project
can override them, and every helper receives the result. Change them by asking
Clankie, in the app's project settings, or with `clankie fleet` on a DIY
installation. Preferences never widen access.

When Clankie needs your decision or an action only you can take, he can leave a
structured ask showing what waits, his recommendation and the exact next steps.
The console's `/question list` collects pending asks; answering wakes the source
conversation. The app mailbox is a later addition. See the [ask reference](/cli/#owner-asks-conversations-questions-id-and-conversations-answer).

DIY helpers use the harnesses you install and sign in to
([bring your own team](/diy/#bring-your-own-team)). Hosted helper limits follow
your [plan](https://clankie.bot/#plans).

## The app

**Messages is home.** Clankie is pinned at the top, with a contact for each
agent so you can follow a larger job without a terminal.

| View     | When it helps                                                                      |
| -------- | ---------------------------------------------------------------------------------- |
| Messages | Talk to Clankie, read replies and files, or message an individual helper.          |
| Commons  | See the team as a little world of agent figures; tap one to open its conversation. |
| Terminal | Watch the real terminal behind a worker, and type into it if your device may.      |

What each device can do depends on the host and the access granted when it
paired. Messages alone is enough to use Clankie.

## Discord, voice, and game night

On a configured Mac, Clankie can chat in Discord, talk in voice channels, play
requested YouTube music, and play Pokémon from his own seat in a PokeAgents
world. None of this is part of basic setup.

The official bot handles text, voice, and a watch-me-play Activity. Sharing
art, animations, and demos through the Activity is built but still awaiting its
live Discord check. Watching someone's screen share and going Live need the
separate personal-lab body. Start with [Discord and play setup](/diy/#hang-out-and-play).

## Leaving work running

Closing a window does not stop the service. A local Mac must stay awake and
online; hosted availability follows your plan.

<a id="give-him-ongoing-work"></a>

To keep him working across turns, give the conversation a goal:

```text
/goal Improve the project's onboarding guide and verify its examples
```

He keeps working toward it and can wake himself later, with no more tools or
access than an ordinary turn. If he proposes a goal himself, `/goal accept`
starts it. Goals default to a 1,000,000-token budget (`/goal --tokens N …` to
change it), and `/goal pause`, `resume`, or `clear` controls one. From a script,
use [`clankie conversations goal`](/cli/#conversations-list-show-id-tail-id-goal-id). Goals run in Clankie's
own conversations, not in a harness seat. Autonomy is on by default;
`/autonomy off` stops goal runs and self-wakes everywhere. On a local Mac,
[`clankie autostart enable`](/cli/#autostart-enable-autostart-disable-autostart-status)
keeps the service running after login.

Next: [how he works](/how-it-works/) explains what sits underneath.
