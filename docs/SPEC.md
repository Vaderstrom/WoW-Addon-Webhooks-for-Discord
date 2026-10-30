# WoW Addon Webhooks for Discord: specification

Source of truth for what the app does and says. The plugin contract (what an addon or plugin gives the app) is in
`docs/PLUGINS.md`. Status: 30 Oct 2026, read by Vaderstrom; W1, W2, W3 (flows, §5.1–5.3), W4 (Only if, screenshots),
W5 (flows in two columns, §5.1–5.2, §8), W6 (game art, §7.1), W7 (code plugins, §3, §6) and W8 (the release, §10) built.

## 1. What it is
A Windows desktop app (Mac later) that posts World of Warcraft addons' news to Discord channels through webhooks.
WoW addons have no network access; this app reads what they save on the player's computer (their SavedVariables)
and posts it, with pictures from the addon and from the player's own game (§7.1). One app serves every addon that brings a **plugin**, so a player who uses three such addons runs one
app, sets up Discord once and routes each addon's posts to the channels they want.

It grew out of the Journey Together Companion for Discord (in the Journey Together Forever repository, 28–29 Oct
2026). Journey Together Forever becomes its first plugin, Guild Hall its second.

**Name.** "WoW Addon Webhooks for Discord" (29 Oct 2026; before, "Addon Webhooks for Discord"): "WoW" says whose
addons, "for Discord" comes last, to respect Discord's brand rules. Never "Discord Addon Webhooks", and no Discord
or Blizzard logo or art. The Settings tab and the README say: "Not made by or affiliated with Blizzard Entertainment
or Discord. World of Warcraft (WoW) is a trademark of Blizzard Entertainment." The repository and its folder stay
`AddonWebhooks` (no player sees them).

**No server and no bot.** A webhook takes posts and edits straight from the app. Nothing goes anywhere else: no
analytics, no accounts.

**When it posts.** WoW writes SavedVariables only on logout, `/reload`, closing the game or a disconnect (not after a
crash). The app watches the files (it looks at their times every few seconds and reads one only when it changed) and
acts each time one changes, so posts arrive after a session, not live. While its window is open it also watches the
game program: while it runs, the window says "The game is running. Posts are sent when you log out, type /reload or
close the game."; when it closes, the files are read once more. From the tray it does not look for the game, as that
costs more than looking at the files and posting does not need it.

## 2. Words
| Term | Meaning |
|---|---|
| **Plugin** | What teaches the app about one addon: what to read, which kinds of post it offers, how its pictures look. |
| **Data plugin** | A plugin of files only: a manifest, an optional picture template, pictures. The addon itself writes ready-made posts in its saved data. **Found by itself** in the addon's folder. No plugin code runs in the app. |
| **Code plugin** | A plugin with a JavaScript file that turns an addon's saved data into posts (for an addon that writes none itself). **Installed by hand** in the app, after a warning. It runs locked away and gets only its addon's saved data (§6). |
| **Group** | What a plugin's posts are about: a fellowship in Journey Together, a guild in Guild Hall. The plugin names the word ("fellowship"). An account can have several. |
| **Kind** | A kind of post a plugin offers: "Progress board", "Dungeon cleared", "Stocks". Each is either **kept** (one message kept up to date) or **news** (a new message each time). |
| **Channel** | A Discord channel the player connected with a webhook URL (a webhook posts in one channel only). It gets what the lines bring it, and may have threads the player added. |
| **Flow** | One line on the Flows page: a kind of one group (or of every group) to a channel or one of its threads (§5.1). |
| **Rule** | Something on a line that changes how its posts go out: Only when, Mention a role, Gather into the daily post (§5.2). A channel has its quiet hours and its daily post's time. Rules belong to the app and work the same for every plugin. |

## 3. Finding plugins
- **Data plugins** live in the addon: `Interface\AddOns\<Addon>\Webhooks\webhooks.json` plus its files. The app looks
  in the AddOns folder of every game version it watches (§4; before any is chosen, of every one) and lists each addon with a plugin. A plugin found for
  the first time is listed, not switched on: "Found: Journey Together Forever. Use it?" (**Use** / **Not now**).
  Updating the addon (CurseForge or by hand) updates its plugin; the app notices a changed manifest and reloads it.
  An addon installed under another folder name (a developer's copy, "JourneyTogetherForever-Dev") saves its data in
  another file and table; its plugin names them (`copies`, `docs/PLUGINS.md` §2), and the app reads those. The addon
  and a copy of it both installed: the first folder found counts.
- **Code plugins** come as a `.zip` file. Addons → **Install a code plugin…** picks the file, reads and checks it
  (its manifest, its script, its file names; a broken one is refused with one sentence and nothing is installed),
  and shows in the window, before anything is installed:
  > **This plugin contains code.** Only install it if you trust whoever made it. The app runs it locked away: it can
  > read the saved data of the addon it is for, and nothing else on this computer. It cannot see your Discord
  > webhook URLs or reach the internet. Plugin: "{name}" by {author}, for {addon}.
  > **Install** / **Cancel**

  with, when it applies, "It replaces version {old} of this plugin, which is installed, with version {new}." and "It
  is used instead of {other}, which is for the same addon." Installed code plugins sit in the app's own folder
  (`%APPDATA%\WoW Addon Webhooks for Discord\plugins\<id>\`), are listed with a "Contains code" mark, and are
  removed with **Remove** (pressed twice), which also deletes what their script kept. They update only when the
  player installs a newer file. A code plugin is never installed or updated by itself. One installed is in use at
  once. A code plugin with the id of a plugin found in an addon is not installed (settings and lines go by id).
- A data plugin and a code plugin (or two code plugins) for the same addon, that is, reading the same saved data:
  only one is in use. Ticking one unticks the others; each says which others there are.
- A plugin that is broken (bad manifest, an unknown `contract` number, a template that fails) is listed with one plain
  sentence ("Journey Together Forever: this plugin needs a newer version of the app.") and posts nothing; the others
  keep working.

## 4. Games and accounts
As in the Companion: the app finds the WoW folder in the usual places or lets the player pick it, and lists every
game version and account by the game's name, never its folder name: **WoW Forever**, **Retail**, **Classic**,
**Classic Era**, **Classic Anniversary** (and PTR or Beta), Forever first, each with its account
("Retail · BLACKVICE940414"). The ticked ones are watched; those where a used plugin finds data are ticked at first.
The same group saved in two of them: the newer save wins.

## 5. What it posts, and where
Decided 29 Oct 2026: the player draws where posts go, as flows. Built in milestone W3, Only if in W4. The same day
the flows became **two columns** (W5): what an addon posts on the left, where it goes in Discord on the right, and
the rules on the lines. The player's words: "Should only be mapping between addon information => webhook with its
mapped text channel"; step boxes in between read as a second process. A new player should find it easy at once:
find the addon, paste one webhook, press Post.

### 5.1 Flows
The player decides what goes where by drawing lines on the **Flows** page (§8), from what an addon posts to where
it goes. One line is one flow. A line may carry rules, and a channel has its own times (§5.2).
- **Left: what your addons post**, as a tree. Each plugin in use, then its groups, then each group's kinds, with the
  plugin's names and help lines. The first group in the tree is **Every {group}** ("Every fellowship"). Lines from
  it count for every group, including groups saved later. A plugin with a `weekly` block has one more kind,
  **Weekly summary** (§5.3).
- **Right: where it goes in Discord.** One box per connected webhook, named after its channel (a webhook posts in
  one channel only). Under a channel, its **threads**: each is a place of its own, and a line to a thread posts in
  that thread. **Add a channel** opens the connect form (§8, step 2); a channel's settings add its threads.
- **Lines.** Drag from a kind's dot to a channel or a thread. Without dragging: click the kind (or press Enter on
  it; Tab moves from box to box) and choose **Send to…**. A second line between the same two boxes is refused:
  "These two already have a line."
- One kind may go to several places, and one place takes many kinds. A kept kind that goes to two places has its
  own kept message in each.
- **Tags on a line** name its rules: "Chapter ≥ 5 · @Fellowship", "In the daily post". A line without rules has
  none. Click a line or its tag to set its rules.
- **Posted once per channel.** When two lines bring the same item to one channel (Every fellowship and Iron Oath,
  or the channel and one of its threads), it is posted once. The line drawn first counts; the other says "Already
  reaches {channel}." and does nothing. A line with Only when brings only some items, so it never stands in for
  another: "Every fellowship → #events, only when Who includes Lea" and "Iron Oath → #events" both count, and a clear
  both bring is posted once, the way drawn first.
- **The flows in words**, under the canvas, one per line: "Chapter complete · Every fellowship → #events: only
  when Chapter is at least 5, mentioning @Fellowship". Kinds with no line are listed as "Not posted: Pictures from
  runs."
- **Removing.** A line from its settings. A thread or a channel asks twice first, because its lines, settings and
  remembered messages go with it.
- **No backlog** (§5.3) counts for every new line: drawing a line is like ticking a kind.
- **Choices from before** become lines once. W1–W2: each channel's ticked kinds and groups become lines to it, its
  role the lines' mention on the kinds that allow one. W3–W4 (step boxes): each path through steps to a channel
  becomes one line from its kind to that channel, or to the thread its Into a thread named; its Only if becomes the
  line's Only when, its Mention a role the line's mention, a Digest "Gather into the daily post". The first Digest's
  time and the first Quiet hours on the way to a channel become that channel's. A path that went nowhere is dropped.

### 5.2 Rules on a line, times on a channel
Rules belong to the app: they work the same for every plugin and never use an addon's rules. A line's settings
offer only the rules its kind can take, and show **What Discord shows**: the newest saved item of that kind as it
would be posted there, rules applied (or "Nothing saved for {kind} yet." until there is one).

| On a line | What it does | Offered for |
|---|---|---|
| **Only when…** | Lets an item through only when one of its fields matches, for example "Chapter is at least 5", "Dungeon is The Deadmines" or "Who includes Lea, Pata" (values separated by commas: any of them; "does not include" none of them). Only fields the plugin names (`fields`, `docs/PLUGINS.md` §2), with the tests that fit (a number: is, is not, is at least, is at most; a text: is, is not; names: includes, does not include) and, for text and names, the values seen so far. Text matches whatever the case. An item without the field does not get through, nor does anything before a field and value are set. Changed, it starts from then: what it held back before is not posted now (no backlog). The settings say what it does to what is saved now: "3 of the last 12 would be posted here." | News kinds whose plugin names fields. |
| **Mention a role** | Mentions one Discord role in each post: its ID, and a name for it that only the app shows ("@Fellowship"). Only that role is pinged, never @everyone or a person (`allowed_mentions`). | News kinds whose plugin allows it (`mention`). Not kept kinds, since an edit pings nobody. |
| **Gather into the daily post** | Instead of a post per item, the item goes into its place's daily post, at the channel's time: one post per group, with the group's name, then one line per item, oldest first. It is at most 1900 characters (more goes into a second post) and carries up to 10 of the items' screenshots and pictures. Every line that gathers into one place goes into the same post. If nothing was gathered, nothing is posted. | News kinds. Not kept kinds and not the weekly summary. |

| On a channel | What it does |
|---|---|
| **Quiet hours** | Off at first. Holds posts between two times (23:00 to 08:00 when ticked) and sends them when the quiet hours end, oldest first. A kept message is edited then. They count for the channel's threads too. |
| **The daily post** | When gathered posts go out: **daily at** a set time (21:00 at first) or **every hour**. Set to another time, what was gathered goes out at the new time. |
| **Threads** | **Add a thread**: its link (in Discord, right-click the thread → Copy Link) and a name for it in the app. The thread must be in this webhook's channel. Discord says whether it may be used only when the app posts: a thread that was deleted or is in another channel stops its lines with "Discord did not accept the thread. It may have been deleted, or be in another channel: use a webhook of that channel." A forum channel needs no threads (§5.3). |

On its way a post meets Only when, then the mention, then the daily post, then quiet hours. Gathered and held posts
survive the app closing. If the app was closed when a daily post or the end of quiet hours was due, it posts once
when it next runs.

### 5.3 Posting
- **Kept** kinds (a progress board, a guild's standings): one message per channel, group and kind (and thread),
  posted once and then edited when the addon saves something newer. Never a new message each time. At most one
  edit per file save. A kept message posted anew after setup (deleted in Discord, or a new line) is named on Home
  until the player presses Done: "New in Discord: Progress board of Iron Oath in #progress. Pin it so everyone finds
  it."
- **News** kinds: a new message per item, each posted once per channel (remembered by its id).
- **Forum channels** take only forum posts, so there each news item gets **its own forum post**, titled with the
  item's name, and a kept kind one forum post ("Iron Oath · Progress board"), kept up to date. Nothing needs setting:
  Discord tells the app which channels are forums the first time it posts (the test message then becomes a forum
  post titled "WoW Addon Webhooks for Discord"), and the app remembers it. Its box says "Discord forum".
- **No backlog.** When a channel is connected, a line is drawn, or posting resumes after a pause, kept messages are
  posted at once and news only from then on.
- **Weekly summary** (a framework feature a plugin can use, `docs/PLUGINS.md` §5): a kind under each group in the
  tree, so lines decide where it goes. It posts Sunday at 20:00 on the player's computer, one post per group, in the
  plugin's own words:
  - the numbers that changed that week (levels: "Lea 25 → 29");
  - the week's news of chosen kinds ("Dungeons cleared: Blackfathom Deeps").

  The app keeps its own daily record of the numbers (15 days). If nothing changed, nothing is posted. A missed week
  (the app was not running) is posted once when the app next runs.
- **Sender.** Every post goes out under the group's name as its sender. When Discord refuses that name (for example
  one containing "discord"), the webhook's own name is used.
- **Text.** Text is plain: Discord formatting in player-made names is escaped, link previews are off, and a post is
  at most 1900 characters. Nobody is mentioned except the role a line mentions (§5.2).
- **Pictures:** a plugin's own pictures (JPG, PNG, or TGA from the addon's Media, which the app converts), a picture
  from the game's own files (§7.1), or a picture the app draws from the plugin's template (§7). A news item's picture
  from the game goes as a JPEG of the part the addon names, at the shape it names, at most 1920 pixels wide; when the
  game does not have it, the text goes without it.
- **Screenshots** (W4): a news item that names when the game took a screenshot (`screenshot`, `docs/PLUGINS.md` §3)
  gets that screenshot attached, before the plugin's own picture. The app looks for that one file in the Screenshots
  folder of the game version the group was saved in (`WoWScrnShot_MMDDYY_HHMMSS`, by this computer's clock, at that
  second or up to three later), reads it and never lists or changes the folder. It goes as a JPEG at most 1920
  pixels wide. Not found (moved or deleted): the text goes without it. A daily post carries its items' screenshots too.
  A post carries at most 10 files and 8 MB, and pictures past that are left off.
- **Discord limits** are respected: `429` and `retry_after`. One failing channel does not stop the others.

## 6. Code plugins: locked away
A code plugin's script runs in a hidden, sandboxed window with no Node.js, no network (every request but its own
files is refused) and no access to other files. The app hands it the parsed saved data of the addon it is for (as
plain data, never the file path) and what it returned last time; it returns posts in the same shape a data plugin's
addon writes (`docs/PLUGINS.md` §3). The app checks that shape, then posts. The plugin never sees a webhook URL and
never posts by itself. A script that takes longer than 5 seconds or throws is stopped, and the window says so.
(Built in W7, 30 Oct 2026.)
- **When it runs:** for each watched game and account where its addon's saved data is, when that file changed since
  the script last ran there, or the plugin was installed again; before each posting and when the window opens. One
  script at a time. A plugin not in use never runs.
- **The walls:** a window of its own, in a session of its own, on an empty page that may load only that plugin's own
  `.js`, `.mjs` and `.json` files (never kept by the browser, so a newer install runs at once). Any other request
  is refused; one to the internet also stops the script and is named ("tried to reach example.com"). Behind that,
  every connection goes to a proxy that is not there and WebRTC sends nothing (checked with a STUN server on this
  computer: an ordinary window reaches it, a plugin's script, also from inside a frame, does not). Picture templates
  get the same two walls.
- **Stopped, and why** (on the Addons tab, under the plugin): it tried to reach the internet; it tried to open
  something that is not its own; it tried to use Node.js (`require` and the like are not there); it took longer than
  5 seconds (a loop, or a promise that never ends: its window is closed and its process with it); it stopped with an
  error (the message); it gave back something that is not an outbox. Nothing from that game is posted until it runs
  well again, at its next save or with **Look again**.
- **What it returned last time** is kept per game and account in the app's folder (`plugin-data\<id>\`, at most
  4 MB), so a restart does not lose it. Fields the app does not know are not used, but come back in `last`.
- A kept message is edited when its group's `saved` time is newer, as for any addon: a newer version of a plugin
  shows at its addon's next save, or with **Update Discord now**.

## 7. Pictures from templates
A plugin may bring an HTML page that draws a picture from the data its addon saved (Journey Together's board, from the
mockup `companion-board.html`). The app opens it in a hidden, sandboxed window that may load only the plugin's own
files: no network, no navigation. It captures the element the template returns, at most 1600 × 2400 pixels, after
the page has painted. One picture at a time; each group's picture is drawn once per save.

### 7.1 Game art (W6, 30 Oct 2026)
The game's own pictures (a dungeon's loading screen, for example) live in its data files, not in any addon, and an
addon may not ship copies of them. So the app reads them from the player's own game, the way the game itself draws
them: an addon names a picture by its **file id** (the number the game knows it by, `docs/PLUGINS.md` §3, §6), and the
app finds that file in the game's data folder (`Data\data`, Blizzard's storage), for the build of the game version the
group was saved in, and turns it into a PNG.
- **Read only.** The app reads the build's settings (`.build.info`, the game version's `.flavor.info`, `Data\config`),
  the storage's index files, and the parts of the archives it needs to find and read the files asked for. It never
  writes in the game's folder and never lists files beyond the index files.
- **Only what is out.** An encrypted file (content not released yet) is not read. A file the game has not downloaded
  yet (a game still installing) is not there; each game version's pictures come from its own build, never borrowed
  from another one (Forever's copy of a picture may differ from retail's).
- **Kept.** Each picture is kept as a PNG in the app's own folder (`game-art`, per game build), so the game's data is
  read once per picture; a game update drops that game's older pictures.
- **Limits.** At most 40 pictures from the game per template picture; a file over 32 MB is not read.
- Not there (an older app, no game folder, not in this build): the template draws without it, and a news post goes
  without it.

## 8. The window
**The first time: three steps**, one at a time, with a bar on top (Addons, Discord, What goes where), Back and Next.
1. **Find your addons.** "The app finds addons that can post to Discord." The step lists each addon with a plugin,
   with its groups ("Journey Together Forever · Iron Oath, a fellowship led by Victor, saved 5 minutes ago"). **Use**
   is ticked for all at first.
   - **Where the app looks** (folded; it opens by itself when nothing is found): the WoW folder, and the game
     versions and accounts.
   - Nothing found: "No addon with a Discord plugin found yet. Addons save their data when you log out, type /reload
     or close the game. Do that once, then press Look again."
   - An addon whose outbox is saved but has no groups shows its plugin's `empty` sentence, or "{addon} has nothing
     to post yet. When it has, type /reload in the game and press Look again." Next waits until a group is there.
2. **Connect a Discord channel.** As in the Companion:
   - what a webhook is, and three numbered lines on getting one (channel settings → Integrations → Webhooks → New
     Webhook → Copy Webhook URL);
   - the URL, and a name for the channel (only shown in the app);
   - **Connect**, which sends a test message: "WoW Addon Webhooks for Discord is connected. Posts from your addons will
     appear here.";
   - "A webhook URL works like a password: anyone who has it can post in that channel. It stays on this computer,
     stored encrypted."
3. **Choose what goes where.** The Flows canvas (§5.1) with the channel just connected.
   - To start, each kind its plugin suggests (`default`) has a line from **Every {group}** to that channel, so most
     players only press **Post**. "You can change it later under Flows."
   - **Add a channel** connects another without leaving the step; lines and their rules work as on the Flows page.
   - Kept kinds with a picture show **What Discord shows**.
   - **Post** posts the kept messages and opens Home: "Posted. Pin the board in Discord so everyone finds it."

**After setup: four tabs.**
- **Home**:
  - one status sentence: "Discord is up to date.", "Posting is paused.", or the problem, naming the addon and
    channel;
  - the last post, and "The game is running. …" while it runs;
  - **Update Discord now**, and **Pause posting** / **Resume posting**;
  - each addon in use, with its groups and what Discord shows.
- **Flows** (§5.1):
  - on top, **Add a channel** and one hint: "Drag from a dot to a channel. Click a line to add rules to it, or a
    channel for its times and threads.";
  - the canvas in two columns, with the flows in words under it.

  Clicking a box or a line opens its settings beside the canvas (under it in a window narrower than 900 pixels):
  - a kind: its help line, **What Discord shows** for a kept kind with a picture, its lines (each with **Rules** and
    **Remove**) and **Send to…** with each place it has no line to yet;
  - a line: "{kind} → {place}", its group, the rules its kind can take (§5.2), **What Discord shows**, and **Remove
    line**;
  - a channel: its name, **Send test post**, **Quiet hours**, **The daily post**, its threads with **Add a thread**,
    its lines, and **Remove channel** (pressed twice);
  - a thread: its name, its lines, and **Remove thread** (pressed twice).
- **Addons**:
  - every plugin found or installed: name, version, author, data or "Contains code", **Use** on/off, the other
    plugins for the same addon, and problems (a code plugin's script: why it was stopped);
  - **Look again** (failed scripts run again), **Install a code plugin…** (the warning shows under it), and **Remove**
    (code plugins only, pressed twice).
- **Settings**:
  - where the app looks;
  - "Show a Windows notice when something goes wrong";
  - "Start with Windows (it waits in the tray)";
  - **Recent posts**: the last 50 posts and failures (when, addon, channel, group, what, and the line's rules);
  - at the bottom, "Not made by or affiliated with Blizzard Entertainment or Discord. …" (§1).

**The tray**: **Open**, **Update Discord now**, **Pause posting** / **Resume posting**, **Quit** (and **Restart to
update**). Closing the window keeps the app in the tray.

All window texts live in `src/locales/enUS.json`. Plugin texts (kind names, help lines, weekly words, field names)
come from the plugin. Post texts come from the addon or the code plugin, as they are.

## 9. Moving from the Journey Together Companion
The Companion was never released, so there is nothing to migrate for players. For the one test install: on the
first start (no settings yet) the app reads the Companion's settings (`%APPDATA%\Journey Together Companion for
Discord\settings.json`) if they exist and takes the WoW folder, the game versions watched and the two options. Its
channels stay behind: their webhook URLs are encrypted with the Companion's own key (Electron's safeStorage keeps a
key per app), which this app cannot read. A channel connected again starts without a backlog, so nothing is posted
twice; a board message the Companion posted stays in Discord and can be deleted by hand. (Decided 29 Oct 2026: the
one test install had no channel connected.) The Companion code in the Journey Together repository was removed in W2.

## 10. Install and updates
A Windows installer (NSIS, per user, no admin rights) on this repository's Releases page, built by a workflow for
each `vX.Y.Z` tag. The repository is the app's own, so updates use electron-updater's GitHub provider directly
(the Companion needed a separate feed because it shared releases with the addon). Not signed for now (SmartScreen:
More info → Run anyway). Addons that bring a plugin say on their CurseForge page where to get the app.
- The repository on GitHub is `Vaderstrom/WoW-Addon-Webhooks-for-Discord` (public), with the source, the docs and the
  release workflow (`.github/workflows/release.yml`, on `windows-latest`: tests, then `electron-builder --win
  --publish always`). Its Releases hold the installer, its blockmap and `latest.yml`.
- The installed app looks for a newer version at start and once a day, downloads it in the background, and offers
  **Restart to update** in the window and the tray; quitting installs it too. Not while developing.
- The installer puts the app in `%LOCALAPPDATA%Programswow-addon-webhooks-for-discord`, with a Start menu and
  a desktop shortcut. Uninstalling (Windows Settings → Apps) leaves the settings in
  `%APPDATA%WoW Addon Webhooks for Discord`.
- The README is for players (install, setup, what the app reads, code plugins, uninstall) and for addon developers
  (the plugin contract and the check mode). (Built in W8, 30 Oct 2026.)

## 11. Open questions
- Code plugins: a list of plugins someone has reviewed, shown in the app? (Not now: install by hand only.)
- Code plugins: run them once for "What Discord shows" before the player installs? (Not now: only installed ones run.)
- Picture formats: should a data plugin be allowed to ship its own fonts? (Now: system fonts only.)
- Game art by the game's path for a file ("Interface\EncounterJournal\…") as well as by its file id? (Now: by id.)
- Other languages for the window and for plugin texts (`webhooks.json` could carry `texts.deDE`).
- Flows: may a plugin suggest a layout (its kept kinds to one channel, its news to another)? (Not now: one channel to
  start, the player draws the rest.)
- A style step for Discord embeds (a coloured card with title and time) next to plain text?
- Mac: notarization needs a paid Apple developer account and a Mac to test on.
- A code-signing certificate for Windows (costs money every year).
