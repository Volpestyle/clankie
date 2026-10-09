# Named worker grids

Use the group's repository workspace, explicit pane IDs and `--no-focus`.
Create your own named worker tab, fill four positions, then open a second
named tab. Do not reuse a lead pane or rearrange existing owner panes.
Record each returned ID; labels are display names, never ownership proof.

```sh
herdr tab create --workspace WORKSPACE --cwd CHECKOUT --label "kh2 authors" --no-focus
# Record result.tab.tab_id as TAB and result.root_pane.pane_id as P1.
herdr pane split --pane P1 --direction right --ratio 0.5 --cwd CHECKOUT_2 --no-focus
# Record result.pane.pane_id as P2 (top-right).
herdr pane split --pane P1 --direction down --ratio 0.5 --cwd CHECKOUT_3 --no-focus
# Record result.pane.pane_id as P3 (bottom-left).
herdr pane split --pane P2 --direction down --ratio 0.5 --cwd CHECKOUT_4 --no-focus
# Record result.pane.pane_id as P4 (bottom-right).
herdr pane layout --pane P1
herdr tab create --workspace WORKSPACE --cwd CHECKOUT_5 --label "kh2 authors · 2" --no-focus
```

The positions fill right, down, then right. Herdr splits individual leaves:
the fourth position uses `down` on the top-right pane, rather than `right` on
the bottom-left (which would make two narrow panes in the left column).
Never add a fifth pane to the full tab. Give each new pane a human worker name
with `herdr pane rename PANE "Name · role"`. Start its visible native harness
through the supported launch route; dispatch briefs through native channels,
never terminal typing. Native harness subagents stay inside their harness.

For initial-command launches, create only the new worker's temporary tab, then
move that new pane into the group with the target/direction from above:

```sh
herdr pane move NEW_PANE --tab TAB --split down --target-pane P2 --ratio 0.5 --no-focus
```

Use `result.move_result.pane.pane_id` as the current ID; qualification can
change across workspaces. The empty temporary tab closes automatically.

Herdr's same-tab `pane move` silently does nothing. Only when the owner
explicitly requests rearrangement of an existing pane, move that pane out and
back; the temporary tab closes and its terminal/process survives:

```sh
herdr pane move OWNED_PANE --new-tab --label "layout temporary" --no-focus
# Read result.move_result.pane.pane_id as MOVED_PANE.
herdr pane move MOVED_PANE --tab TAB --split down --target-pane TARGET --ratio 0.5 --no-focus
```

If creation or move loses its reply, inspect the original pane and tab before
doing anything else. Never allocate a replacement to test an uncertain receipt.
