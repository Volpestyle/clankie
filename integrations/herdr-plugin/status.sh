#!/usr/bin/env bash
# Popup body for the `status` pane: herdr closes the popup when the command
# exits, so hold the report on screen until a key is pressed.
clankie status
printf '\npress any key to close'
read -r -n 1 -s
