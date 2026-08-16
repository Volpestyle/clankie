# apps/discord-user-session/src/stream-watch.ts

`startStreamWatch()` owns screen-share watch/publish sessions on the user-account body. It joins the target voice channel without creating a second mouth, sends Go Live watch commands, hands stream-server credentials to ClankVox, and posts decoded stills to the service projection.

The same controller can publish a URL or pump PNG frames from the local activity surface when this process is the active mouth.
