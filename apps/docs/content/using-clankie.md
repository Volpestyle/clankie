# Using Clankie

Start with what you want to do. Clankie can help you think something through,
make a draft or picture, remember a preference, and bring in help for a larger
job. You do not need to learn agent terminology to talk to him.

## Everyday help

Give him a little context and a useful outcome. A few things to try:

- “Turn these scattered notes into a plan for the weekend.”
- “Help me draft a kind, clear reply. Here's what happened.”
- “Compare these three ideas and tell me what you would choose.”
- “Make a birthday-card picture with a sleepy robot in a garden.”

You can steer him as he works: add a constraint, correct an assumption, or ask
for a shorter answer. If a request needs a connection he does not have, he
should say what is missing. A request to draft a message and a request to send
it are different instructions; tell him which outcome you want.

## Memory and personality

Tell him what matters, and ask him to keep it: “Remember that I prefer quiet
places and short walks.” You can ask what he remembers and correct a stale
note. In the local console, `/memory` lets you inspect, edit, retain, and forget
memories directly.

His memories are selected notes, separate from conversation history. Recent
notes can age out; retained notes stay until released or forgotten, within the
store's capacity. He can search what he has kept, but memory is not a promise
to reproduce every past message. The [memory reference](https://github.com/Volpestyle/clankie/blob/main/docs/memory.md)
explains retention and privacy between conversations and Discord rooms.

Clankie has a character of his own. On a DIY installation, `/persona` lets you
shape his name and character; it does not require rebuilding the software.

## Making things together

Explain the purpose, audience, and constraints. A useful brief might be:
“Help me make a simple website for my bakery. Start with the opening page and
show me a preview before publishing anything.”

Ask for the finished file or a preview you can inspect. Files he delivers belong
to the conversation, so you can return to the result. Images require an image
model; short video generation is a separate, optional capability on a configured
DIY installation. A render may take time. Ask what is still running rather than
starting a duplicate request.

## Bigger jobs and helper agents

Clankie can do work himself or assemble a team. Tell him the outcome, your
constraints, and any decisions you want to make yourself. You can ask who is
doing what, open a helper's conversation, and steer the work as it develops.

For DIY users, helper agents use the installed and authenticated tools you
choose. [Customize Clankie](/diy/#bring-your-own-team) explains the setup. Hosted
worker availability depends on the service and plan; the [current plans](https://clankie.bot/#plans)
are the source for those limits.

The tiny town in **Commons** shows the team at work. Select a figure to reach
the agent behind it, see their progress, or ask a follow-up. The **Bulletin**
lists every open task, who assigned it and who holds it, with stuck work first.
Tap a notice to message whoever holds it.

## The app

**Messages is home.** Clankie is pinned at the top. Start there for a question,
an idea, or a piece of work. Agent contacts and shared conversations let you
follow a larger job without keeping a terminal open.

| View     | When it helps                                                                                                          |
| -------- | ---------------------------------------------------------------------------------------------------------------------- |
| Messages | Talk to Clankie, read replies and files, or speak to an individual helper.                                             |
| Commons  | See the team's activity as a small world of agent figures; select one to open its conversation or controls.            |
| Terminal | Inspect the actual terminal behind a connected worker, with direct input when your device has the required permission. |

The app reaches the same service as your other connected devices. Available
controls depend on the host's capabilities and the access granted to that
device. You can use Messages without learning the deeper views.

## Discord, voice, and game night

On a configured Mac, Clankie can join Discord conversations, speak in voice,
play requested YouTube music, and play Pokémon from his own seat in a separate
PokeAgents world. These are optional integrations, not part of basic setup.

The official bot supports text, voice, and the watch-me-play Activity.
Watching someone else's screen share and publishing Discord Go Live use the
separate personal-lab body, with its own explicit opt-in and restrictions.
Those distinctions matter when you try something you saw in the promo. Start
with [Discord and play setup](/diy/#hang-out-and-play).

## Leaving work running

Closing a window does not stop the service. A local Mac must stay awake and
online; hosted availability follows its account and resource limits.

For a DIY task that should continue across turns, use `/goal` and explicitly
enable `/autonomy`. You can pause the goal or turn continuation off. This is
separate from keeping an ordinary conversation open. See [ongoing work](/diy/#give-him-ongoing-work)
for the controls and their limits.

Next: [how he works](/how-it-works/) explains the service, memory, models, and
connections underneath. [Get started](/get-started/) covers installation and pairing.

## Give him a visual persona

On a DIY installation, put PNG/JPEG/WebP images or MOV/MP4/WebM videos in a folder and run
`clankie persona images set ~/Pictures/clankie-vibe`, or choose **Persona images**
in `/persona`. Check `clankie persona images status`, then restart Clankie.
Top-level files color his vibe: the feel of who he is, not what he looks like.
Put physical character references in `appearance/`; only these feed self-portraits.
He uses up to eight stills/contact sheets total. Videos need ffmpeg/ffprobe and each
contributes one sheet of ten chronological tiles; audio is ignored. Status lists
viewable sheet paths. His written character wins. Voice uses a short description
instead of images. `clankie persona images clear` clears the selection without
deleting the originals. Images are sent to your configured models when used.
Hosted paths refer to folders already on the hosted machine; this does not
upload files from your phone or Mac. See the [CLI reference](/cli/).
