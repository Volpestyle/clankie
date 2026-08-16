# docs/adr/0082-clankie-holds-the-browser.md

Decision that the service owns one sequential agent-browser host and exposes its live tool catalog to the captain. Everyday tools begin active, tool search discovers the rest, the subprocess receives no Clankie credentials, and stronger filesystem/network isolation requires a VM or remote broker.
