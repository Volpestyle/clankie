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

Clankie can do the work himself or lead a team. Tell him the outcome, your
constraints, and the decisions you want to keep. He plans it into tracked
issues, hires helpers, checks their reports against the evidence, and closes
each issue once it lands. Ask who is doing what, open a helper's conversation,
and steer as it develops.

Tell him how agents should work: “Commit and push without asking, ask me before
releases, and keep reports short.” One autonomy dial sets how many calls he
takes: off, low, high (the default) or full. At high he answers his helpers'
questions, including changes that are hard to undo, commits, pushes and closes
work, and asks you before releases. Money and accounts always come to you. Set
it with `/autonomy`, in the app's fleet settings, or with
[`clankie autonomy`](/cli/#autonomy-dial); the individual settings stay under
Advanced. Owner defaults apply everywhere, a project
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

To keep him working without you, put a project on Auto. In the console,
`/project` opens a project: turn on **Auto**, and set a one-line **Focus** for
what matters now if you like. The project list shows the Auto switch on top and
a status line for each project: agents working, landed today and what needs
you. From a script:

```sh
clankie project settings garden --auto on --focus "Ship offline mode"
```

With Auto on, he works the project's backlog without being asked. He takes the
next ready work from its tracker, staffs it within the project's worker cap and
your machine and account limits, lands it and closes it with evidence. He
carries long work across wake-ups and worker reports, whether
he's in his own console or seated in Claude Code or Codex. The autonomy dial
decides which calls he makes alone; anything left to you arrives as one ask.
Turn Auto off for a project and he starts nothing new on it.

`/auto off` (or [`clankie auto off`](/cli/#auto-switch)) pauses everything
unprompted: projects on Auto, goals and the wake-ups he schedules. `/auto on`
resumes it. Older `/goal` commands still work while goals give way to
Auto. On a local Mac,
[`clankie autostart enable`](/cli/#autostart-enable-autostart-disable-autostart-status)
keeps the service running after login.

<a id="routines"></a>

For work on a cadence, ask for it in plain words ("every weekday morning,
triage new issues") or set up a routine yourself:

```text
clankie routines add "Morning triage" --when "every weekday at 9:00" --turn "Triage new issues"
```

A routine runs a turn in a conversation, hires a helper with a brief, or runs a
check command, on its schedule in your time zone. Each run is logged with its
result; `clankie routines history` and `/routines` show them, and the app lists
them too. If your Mac slept through a run, the routine catches up once when it
wakes (or skips, if you chose that), and it never runs the same slot twice.
A routine can do only what its conversation could already do. Pause, resume,
run now or remove one from any of those places; the full syntax is under
[`clankie routines`](/cli/#routines).

Next: [how he works](/how-it-works/) explains what sits underneath.
