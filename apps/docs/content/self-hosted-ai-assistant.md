# A self-hosted AI assistant for your Mac

Clankie runs on your own computer. Talk to the built-in lead, ask it to remember
something or hire coding agents, and follow the work from the console or a
paired app. You choose the models, services and permissions.

The software is free and open source. Model providers and connected services
may charge; their subscriptions and API keys are separate. You can also use a
local model provider. Clankie itself is not a model.

## Install on an Apple silicon Mac

You need macOS 14 or newer and Apple's Command Line Tools. The
[installation guide](/get-started/#macos) explains the requirements and current
companion-app availability. The service installer is:

```sh
curl -fsSL https://clankie.bot/install | sh
```

Open a new terminal, run `clankie`, choose to run it on this computer and follow
`/setup`. Pick a model and choose how much Clankie may do. Account sign-ins and
keys go into the setup prompts, not into your conversation.

The terminal console is enough to begin. Linux is also supported; Windows
computers can [join as machines](/add-a-machine/) rather than run this installer.

## Start with a small request

Try “Help me plan this project, and remember that I prefer short updates.” For
coding, install and sign in to the harnesses you want him to hire, then give
him a project folder and task. He can [lead Claude Code and Codex](/claude-code-and-codex/)
without replacing their own sign-ins.

Close the console when you want; the service keeps running. If the Mac sleeps
or loses its connection, you cannot reach it remotely. `clankie status` shows
the service state, and `clankie doctor` explains what needs attention.

## Reach it from your phone

Pair the app over your own network with no Clankie account, or configure
remote access through the public gateway. Remote access needs a free account
and an awake, connected computer. Check [current app and account availability](https://clankie.bot)
before starting; use the [pairing guide](/get-started/#bring-your-mac-s-clankie-into-the-app).

The service and saved work stay on your computer. That does not make every
request offline: selected model providers and connected services receive what
you ask them to process. Desktop actions also need the operating system's
permissions; installation alone grants none.

Next: [everyday use](/using-clankie/), [customization](/diy/), or
[add another computer](/add-a-machine/).
