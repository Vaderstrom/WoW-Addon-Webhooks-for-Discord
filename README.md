<img src="assets/icon.png" width="96" alt="">

# WoW Addon Webhooks for Discord

Designed and developed by **Vaderstrom**.

A Windows app that posts World of Warcraft addons' news to Discord channels through webhooks. Addons have no network
access, so the app reads what they save on your computer and posts it: a progress board kept up to date, a new post
for each big moment, a weekly summary. One app for every addon that brings a plugin, such as
Journey Together Forever.

No server, no bot, no account: the app talks to Discord's webhooks straight from your computer, and nothing goes
anywhere else.

Not made by or affiliated with Blizzard Entertainment or Discord. World of Warcraft (WoW) is a trademark of Blizzard
Entertainment.

## For players
The [manual](docs/MANUAL.md) shows every step with pictures.

### Install
1. Download `WoW-Addon-Webhooks-for-Discord-Setup-<version>.exe` from
   [Releases](https://github.com/Vaderstrom/WoW-Addon-Webhooks-for-Discord/releases/latest).
2. Run it. It installs for your Windows user only and needs no admin rights.
3. The app is not signed yet, so Windows may say "Windows protected your PC". Press **More info**, then **Run
   anyway**.

The app keeps itself up to date: it looks for a new version when it starts and once a day, and asks before it
downloads one (**Download and update** or **Later**).

### Set up
The first time, the window takes you through three steps:
1. **Find your addons.** The app finds the addons that can post to Discord in your WoW folder. Addons save their data
   when you log out, type `/reload` or close the game, so do that once if nothing is found.
2. **Connect a Discord channel.** In Discord, open the channel's settings → Integrations → Webhooks → New Webhook →
   Copy Webhook URL, and paste the link in the app. **Connect** sends a test message to the channel.
3. **Choose what goes where.** Each addon suggests what to post; most players just press **Post**. Pin the board
   in Discord so everyone finds it.

After that the app waits in the tray. Closing the window keeps it running there; **Quit** in the tray stops it.
Under **Channels** you can send each kind of post to its own channel or thread, mention a role, keep quiet hours, or
gather posts into a daily one.

**Posts arrive after a session, not live**: WoW writes an addon's saved data only when you log out, type `/reload`
or close the game. The app posts then. It never posts old news it finds on its first start, and never posts the
same thing twice.

### What it reads, and what it keeps
- It reads only what each addon's plugin names: the addon's saved data (its SavedVariables file, which it parses and
  never runs), the one screenshot a post names, and the game's own loading-screen art from your game folder.
- It never writes in your WoW folder.
- **Keep a webhook link to yourself**: anyone who has it can post in that channel. The app keeps it on this
  computer, stored encrypted, and never shows it to an addon or plugin.

### Code plugins
Most addons bring a plugin of plain files, which the app finds by itself. Some may offer a **code plugin** (a
`.zip` file) instead. Install one under **Addons → Install a code plugin…**, and only if you trust whoever made it.
The app runs it locked away: it can read the saved data of the addon it is for, and nothing else on your computer.
It cannot see your webhook links or reach the internet.

### Uninstall
Windows Settings → Apps → Installed apps → **WoW Addon Webhooks for Discord** → Uninstall. Your settings stay in
`%APPDATA%\WoW Addon Webhooks for Discord`; delete that folder too to remove everything.

## For addon developers
Your addon can post to Discord through this app without any network access: it writes ready-made posts in its
saved data (an **outbox**), and a small **plugin** folder in the addon tells the app what they are.
- [`docs/PLUGINS.md`](docs/PLUGINS.md): the plugin contract: the `Webhooks` folder and its `webhooks.json`, the
  outbox, picture templates, weekly summaries, and code plugins.
- [`docs/SPEC.md`](docs/SPEC.md): what the app does and says.
- A sample addon with a plugin: [`test/fixtures/AddOns/ExampleTracker`](test/fixtures/AddOns/ExampleTracker), its
  saved data in [`test/fixtures/SavedVariables`](test/fixtures/SavedVariables). A sample code plugin:
  [`test/fixtures/code/simple-scores`](test/fixtures/code/simple-scores).
- Journey Together Forever's plugin is a full example: its `Webhooks` folder.

### Checking your plugin
The app has a check mode: it reads one SavedVariables file and the plugin for it, and shows every group, kept
message, news item and picture as the app would post them. It posts nothing, needs no Discord channel and runs
beside the app if that is open.
```
"%LOCALAPPDATA%\Programs\wow-addon-webhooks-for-discord\WoW Addon Webhooks for Discord.exe" --check "<WoW>\_retail_\WTF\Account\<ACCOUNT>\SavedVariables\<Addon>.lua"
```
- Without `--plugin`, the plugin is the one in the addon of the same name, in the same game version
  (`Interface\AddOns\<Addon>\Webhooks`). `--plugin "<folder>"` names another (a code plugin's unpacked folder, say).
- The report opens in a window and is saved as `report.html` and `report.txt` with its pictures, in
  `%TEMP%\WoW Addon Webhooks check` or the folder `--out "<folder>"` names. `--quit` saves it without the window.
- A code plugin's script runs as it would in the app, locked away.

## Developing
Needs Node.js 24 LTS. In PowerShell use `npm.cmd` (the execution policy may block `npm.ps1`).
```
npm install
npm test                                  # the tests, no Electron window
npm start                                 # the app
npm start -- --check "<SavedVariables file>"   # the check mode
npm run dist                              # the installer, in out/dist
npx electron src/dev/check-sandbox.js     # what a picture template cannot do
npx electron src/dev/check-scripts.js     # what a code plugin cannot do
```
Window snapshots without a person: `AWD_USER_DATA=<folder>` (made-up settings), `AWD_SNAPSHOT=<file.png>`,
`AWD_SNAPSHOT_VIEW=step=2`, `tab=flows&box=c:<channel id>` or `tab=flows&line=<from>><to>`, `AWD_SNAPSHOT_HEIGHT`,
`AWD_SNAPSHOT_DELAY` (ms). Tests talk to a local fake Discord, never a real webhook.

**Releasing**: push a tag `vX.Y.Z` (the version in `package.json`). The Release workflow builds the installer and
publishes it with its update feed on this repository's Releases; installed apps update from there.

### Files
- `src/main/plugins.js` finds and checks plugins; `outbox.js` reads outboxes; `lua-table.js` parses SavedVariables.
- `src/main/poster.js` decides what to post where; `flows.js` the lines and their rules; `weekly.js` weekly
  summaries; `discord.js` talks to webhooks; `settings.js` keeps the choices.
- `src/main/render.js` draws template pictures in a sandbox; `pictures.js` reads TGA and writes PNG;
  `screenshots.js` finds the screenshot a post names.
- `src/main/game-art.js` and `casc.js` read the game's own art; `game-picture.js` shapes it for a post.
- `src/main/install.js`, `zip.js`, `scripts.js` and `run-script.js`: code plugins, installed and run locked away.
- `src/main/check.js` the check mode; `updater.js` updates (asked first); `wow.js` the WoW folder and game versions.
- `src/main/main.js` tray, window, file and game watching; `src/renderer/` the window; `src/locales/enUS.json` its
  texts.

## License
MIT, see [LICENSE](LICENSE). The Cinzel font in `assets/fonts` is by The Cinzel Project Authors, under the SIL Open
Font License 1.1 ([`assets/fonts/OFL.txt`](assets/fonts/OFL.txt)).
