# Interface theme (`LAVISH_AXI_THEME`) - before/after evidence

Task: one install-wide setting that themes Lavish's own interface (hub, board chrome, conversation
panel, annotation popover, presence pill, menus, banners) with two presets, `night` (dark, deep
purple, no blue) and `day` (light, blue), while board content keeps its own styling and an unset
install keeps today's look.

All screenshots come from a real `lavish-axi server` (loopback, its own state directory) driven
through `chrome-devtools-axi` in headless Chromium, with the same demo board and one agent reply in
every shot. Desktop shots are 1280x800 and phone shots 390x844.

## Before (stock look)

- `before-hub-desktop.png`, `before-hub-phone.png`, `before-board-desktop.png`,
  `before-board-phone.png` - captured from the code before this change.
- `before-annotation.png` - the annotation popover in the stock look, captured on this branch with
  `LAVISH_AXI_THEME` unset.

With `LAVISH_AXI_THEME` unset, this branch's hub and board shots pixel-match the before shots,
apart from the hub's "Updated" timestamp and one frame of the phone dock's pulse animation.

## After: `LAVISH_AXI_THEME=night`

- `night-hub-desktop.png`, `night-hub-phone.png` - night-sky header with a moon, violet "sch" mark,
  purple links and tabs.
- `night-board-desktop.png`, `night-board-phone.png` - purple-black chrome, violet accent on the
  Annotate switch, links, and Send. The board content keeps its own white page.
- `night-annotation.png` - the annotation popover and element outline inside the artifact.
- `night-menu-and-publish.png` - the More menu and the Publish dialog.

## After: `LAVISH_AXI_THEME=day`

- `day-hub-desktop.png`, `day-hub-phone.png` - the stock hub's paper-and-navy look in cooler,
  lighter blues.
- `day-board-desktop.png`, `day-board-phone.png` - light chrome with a blue accent.
- `day-annotation.png` - the annotation popover in day.
