# Changelog

## Unreleased

## 0.1.1 (30 Oct 2026)
- Check mode: it removes only the pictures of its own last report (listed in `report-files.txt`); before, any
  `001-…` picture in the folder `--out` named went. It never writes in a WoW folder, also when the SavedVariables
  file was copied out of one. It reads a plugin as the app does (the same size limits), and runs a code plugin's
  script with what it returned in the app last time. `report.txt` opens right in Windows PowerShell.
- A computer whose pictures never paint waits 15 seconds for the first one only, then 5 for each.
- Release workflow: the release is made as a draft first, the installer and update files go into it, and only then
  is it published, so a release is never seen without its installer; a job run again uses its draft. v0.1.0 got two
  releases for its tag, the blockmap alone in the second (put right by hand). The workflows use checkout and
  setup-node v7 (on Node.js 24; GitHub warned that v4 targets Node.js 20).
- Docs: paths in `docs/PLUGINS.md` §8 and `docs/SPEC.md` §10 had lost their backslashes.

## 0.1.0 (30 Oct 2026)
The first release: one app that posts World of Warcraft addons' news to Discord through webhooks, for every addon
that brings a plugin, with Journey Together Forever as the first. Built in milestones W1 to W8:

- W1, the framework (grown from the Journey Together Companion for Discord): data plugins found in addons'
  `Webhooks` folders and checked (`docs/PLUGINS.md`); outboxes read from SavedVariables (parsed, never run); kept
  messages posted once and edited, news posted once per channel, no backlog; channels follow kinds and groups per
  plugin, with a role on kinds that allow one; pictures from sandboxed templates (served only from the plugin's own
  folder and its addon's Media, TGA read as PNG; no Node.js, no network; a template that hangs is stopped); the
  window: three setup steps, then Home, Discord channels, Addons, Settings; the tray: Open, Update Discord now,
  Pause posting, Quit.
- W2, Journey Together as a plugin: its plugin is found in the addon's own folder. An addon folder that is a link
  (a junction, as developers link a repository into AddOns) is now found; before, such an addon was skipped. A
  picture is captured once its painting has settled (two frames in a row the same): the first Journey Together board
  after a cold start came out without its art. The first start takes the Journey Together Companion's game folder,
  game versions and options; its channels are connected again (their webhook URLs are locked to the Companion).
- An addon whose outbox is saved but empty no longer says "Nothing saved yet" (which sent the player to /reload
  for nothing): a plugin's manifest may say why with `empty`, and without it the app says the addon has nothing to
  post yet.
- W3, flows: the Discord channels tab becomes **Flows**, a canvas where the player draws what goes where. The addons
  as a tree on the left (each plugin, then Every {group} and each group, then its kinds), steps in the middle,
  channels on the right; lines are dragged from a box's dot, or made with the box's Connect to… menu (it offers only
  the boxes a line may go to; a refused line says why on the box). Boxes can be moved and put back with Tidy up; the
  flows are listed in words under the canvas, with what is not posted anywhere. Steps: Mention a role, Digest (every
  hour or daily at a time), Quiet hours, and Into a thread (a thread of the channel). A forum channel gets its own forum post per item, titled with its
  name (Discord says which channels are forums; the app remembers it). What
  a step holds or gathers survives a restart. A plugin's `weekly` block makes a Weekly summary kind (Sundays at
  20:00). Setup's step 3 is the canvas, with lines from Every {group} for the kinds a plugin suggests. Each
  channel's ticks from before become lines, and its role a Mention a role step. Journey Together's plugin has a
  weekly summary (levels, dungeons cleared, chapters completed).
- A kept message posted anew after setup (deleted in Discord, or a new line) is named on Home until Done, so the
  player pins the new one. Before, only the setup asked.
- W4, Only if: a step that lets an item through only when one of its fields matches ("Chapter is at least 5",
  "Who includes Lea"). A plugin names the fields per news kind (`fields` in the manifest, checked) and its addon
  writes them on each item; the step offers the fields of the kinds coming in, the tests that fit and the values seen
  so far, and names the kinds that lack the field. A changed Only if posts nothing it held back before. Two ways
  with Only if into one channel both count, and an item both let through is posted once.
- W4, screenshots: a news item that names when the game took a screenshot (`screenshot`) gets it attached, found by
  that time in the Screenshots folder of the game it was saved in (one file looked for and read, nothing listed or
  written), as a JPEG at most 1920 pixels wide; also in a Digest. A post's pictures stay within 10 files and 8 MB.
  Journey Together writes fields on its news (chapter number, dungeon, who) and its pictures from runs.
- W5, flows in two columns: what the addons post on the left, where it goes in Discord on the right (each channel
  with its threads), and nothing in between. The steps became **rules on a line**: Only when (now also several
  values, separated by commas), Mention a role (with a name for the role that only the app shows) and Gather into
  the daily post; and **times on a channel**: its quiet hours and when its daily post goes out. A line's rules show
  as a tag on it ("Chapter ≥ 5 · @Fellowship"). Clicking a line, its tag or a box opens its settings, with What
  Discord shows (the newest saved item as it would be posted there) and how many of the last saved an Only when lets
  through. A kind's Send to… draws a line without dragging. Threads are added on their channel, from a link and with
  a name, and are places of their own. Step boxes, moving boxes, Tidy up and the box menus are gone. Flows drawn with
  steps become lines once, with their rules; a channel takes the first Digest's time and Quiet hours on the way to
  it. In a narrow window, what is clicked brings its settings into view under the canvas.
- An addon installed as a development copy (another folder name, such as `JourneyTogetherForever-Dev`) is read from
  the file and table that copy saves to, when its plugin names them (`copies` in the manifest). Before, the app read
  the release copy's file and found nothing to post, so setup's Next stayed greyed out.
- W6, game art: the game's own pictures, which an addon may not ship (a dungeon's loading screen), read from the
  player's game by their file id: Blizzard's storage in the game's Data folder, read only (the build's settings, the
  index files, and the archive parts the files are in), never an encrypted file. Each comes as a PNG, kept in the
  app's folder per game build. A template asks with `ctx.game(id)` and crops it itself; a news item's `picture` may
  be `{ game, crop, aspect }`, posted as that part at that shape. Each game version reads its own build. Journey
  Together names each dungeon's loading screen, so the board and clears of classic dungeons show one (before, an empty
  frame).
- W7, code plugins: for an addon that writes no outbox, a plugin with a script, installed by hand. Addons → Install a
  code plugin… reads and checks the `.zip` (its own reader: stored and deflated files, sizes and checksums checked,
  no file outside the plugin's folder), shows the warning in the window naming the plugin, its author and its addon
  (and the version it replaces, or the plugin it is used instead of), and only Install puts it in
  `%APPDATA%\WoW Addon Webhooks for Discord\plugins`. Listed with a "Contains code" mark and Remove (pressed twice).
  Its script runs in a sandboxed window of its own on each watched game's saved data when that changed, gets the
  parsed data and what it returned last time (kept on disk), and its answer is checked like any outbox. A script that
  reaches for the internet or Node.js, takes more than 5 seconds, throws or gives back no outbox is stopped, and the
  Addons tab says why. Only one plugin per addon is in use: ticking one unticks the others.
- Plugin windows (scripts and picture templates): every connection goes to a proxy that is not there and WebRTC
  sends nothing, behind the refused requests; and plugin files are never kept by the browser, so a plugin installed
  again or an addon updated is read anew (a newer code plugin ran its old script until a restart).
- W8, the release: a Windows installer (per user, no admin rights) built and published on GitHub Releases by a
  workflow for each `vX.Y.Z` tag; the installed app updates itself from there. A README for players (install,
  setup, what the app reads, code plugins, uninstall) and for addon developers.
- Check mode for addon developers: `--check "<SavedVariables file>"` (with `--plugin` and `--out`) shows every
  group, kept message, news item and picture as the app would post them, in a report window and in
  `report.html` and `report.txt` with the pictures. It posts nothing, needs no channel, never writes in the WoW
  folder and runs beside the app.
- A picture whose first frame is slow to come (the very first start of a freshly installed app) is asked for again,
  up to three times; before, the board after an install could come out as "The picture could not be drawn."
- Developer: the app takes `AWD_DISCORD` (a fake Discord on this computer) and `AWD_CLOCK_OFFSET` (a moved clock)
  when it is not installed, for trying flows by hand.
- A daily post set to another time posts what it had gathered at the new time; before, that waited for the old time.
- The app looks whether the game is running only while its window is open. Before, it did so every 15 seconds from
  the tray too, starting PowerShell each time; posting never needed it (the saved data files are still watched all
  the time).
- In the settings beside the canvas the arrow keys keep working in a list or a time field: each change redrew the panel and
  dropped the focus, so only the first key press counted.
- The app is now called **WoW Addon Webhooks for Discord** (the window, the tray, the installer, the test message);
  its settings live in `%APPDATA%\WoW Addon Webhooks for Discord`. The Settings tab says it is not made by or
  affiliated with Blizzard Entertainment or Discord.
- Developer: `npm test` (73 tests: manifests, outboxes, TGA and BLP, screenshots, game art from a tiny game storage,
  flows, posting against a fake Discord, code plugins' zips, installs and outboxes, the check mode's command line); `src/dev/check-sandbox.js`
  checks what a template cannot do, `src/dev/check-scripts.js` what a code plugin's script cannot do; `tools/make-icon.js` draws the icon.
