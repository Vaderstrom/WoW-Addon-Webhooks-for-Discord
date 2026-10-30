# Plugins: how an addon posts to Discord with WoW Addon Webhooks for Discord

For addon developers. Draft, 30 Oct 2026. What the app does with all this is in `docs/SPEC.md`.

The idea in one line: **your addon writes ready-made posts into its SavedVariables; the app delivers them.** The
addon keeps its rules and its wording; the app never works anything out about your addon. All you add is a small
`Webhooks` folder.

## 1. The folder
```
Interface\AddOns\YourAddon\
  Webhooks\
    webhooks.json        the manifest (required)
    card.html            a picture template (optional, §6)
    art\...              pictures the posts or the template use (optional)
```
Ship the folder in your addon's package. WoW ignores it; the app finds it in every game version it watches.

## 2. The manifest: `webhooks.json`
```json
{
  "contract": 1,
  "id": "journey-together-forever",
  "name": "Journey Together Forever",
  "author": "Vaderstrom",
  "version": "1.2.0",
  "savedVariables": "JourneyTogetherForever",
  "outbox": "JourneyTogetherForeverDB.webhooks",
  "group": "fellowship",
  "kinds": [
    { "id": "board", "type": "kept", "name": "Progress board", "help": "One picture of the fellowship, kept up to date.",
      "default": true },
    { "id": "chapter", "type": "news", "name": "Chapter complete",
      "help": "A new post each time the fellowship completes a chapter.", "default": true, "mention": true },
    { "id": "clear", "type": "news", "name": "Dungeon cleared",
      "help": "A new post for every dungeon clear, with who cleared it.", "default": true },
    { "id": "picture", "type": "news", "name": "Pictures from runs",
      "help": "The pictures you take with Take a picture after a final boss: the screenshot itself, with who was there.",
      "default": false }
  ],
  "templates": { "board": "card.html" },
  "fields": {
    "chapter": [ { "id": "n", "name": "Chapter", "type": "number" } ],
    "clear": [ { "id": "dungeon", "name": "Dungeon", "type": "text" }, { "id": "who", "name": "Who", "type": "names" } ]
  },
  "weekly": {
    "name": "Weekly summary",
    "help": "Sundays at 20:00: levels gained, dungeons cleared and chapters completed.",
    "head": "{group} this week:",
    "number": "{name} {from} → {to}",
    "news": [
      { "kind": "clear", "text": "Dungeons cleared: {list}" },
      { "kind": "chapter", "text": "Chapters completed: {list}" }
    ],
    "separator": " · "
  }
}
```
| Field | Meaning |
|---|---|
| `contract` | This page's version: **1**. An app that knows a lower one lists the plugin as needing a newer app. |
| `id` | Lowercase letters, digits and `-`; unique; never changes (the app keeps the player's choices under it). |
| `name`, `author`, `version` | Shown in the Addons tab. |
| `savedVariables` | The file name in `WTF\Account\<ACCOUNT>\SavedVariables\` without `.lua` (the account-wide file; per-character files are not read). WoW names it after the addon's folder: letters, digits, `_` and `-`. |
| `outbox` | Where the posts are in that file: the global's name and the keys, joined with `.`. Only this table is read. |
| `group` | The word for what a channel follows ("fellowship", "guild"), used in the window. |
| `kinds` | The kinds of post. `type`: `kept` (one message kept up to date) or `news` (a new message per item). `default`: wired to the first channel during setup (`docs/SPEC.md` §8). `mention`: the player may have a line from it mention a role (`docs/SPEC.md` §5.2). At most 12. |
| `templates` | A kept kind (or a news kind) whose picture the app draws from an HTML page (§6). |
| `empty` | Optional: what the window says when the outbox is there but has no groups, such as why and what to do ("None of your characters is in a fellowship…"). At most 200 characters. Without it the app says the addon has nothing to post yet. |
| `weekly` | Optional: the plugin offers a weekly summary (§5), with its texts. `{group}`, `{name}`, `{from}`, `{to}`, `{list}` are filled in by the app. |
| `fields` | Optional (the app's W4 on): per news kind, the fields the player may filter on with a line's Only when (`docs/SPEC.md` §5.2). See below. |
| `copies` | Optional: other folders your addon may be installed as, such as a development copy, which save elsewhere. Per folder name, that copy's `savedVariables` and `outbox`: `"copies": { "YourAddon-Dev": { "savedVariables": "YourAddon-Dev", "outbox": "YourAddonDevDB.webhooks" } }`. Found in a folder named here, the plugin reads that copy's saved data; anywhere else, its own. At most 4. An app before 29 Oct 2026 refuses a manifest with a `-` in a file name. |

All texts are final, player-facing English, shown as they are.

**`fields`**. Keyed by news kind id, each a list of fields with an `id` (a letter, then letters, digits or `_`), a
`name` shown in Only when, and a `type`:
- `number`: is, is not, at least, at most;
- `text`: is, is not (Only when offers the values seen so far);
- `names`: includes, does not include.

The values come with each item (§3).
```json
"fields": {
  "chapter": [ { "id": "n", "name": "Chapter", "type": "number" } ],
  "clear": [ { "id": "dungeon", "name": "Dungeon", "type": "text" }, { "id": "who", "name": "Who", "type": "names" } ]
}
```
An item without a field Only when asks about does not pass. At most 6 fields per kind; a kept kind has none. Names
are compared as they are written, so write them as the posts show them ("Lea", not "Lea-Realm"). Keep commas
out of text and names values: Only when reads a comma as "or" ("Who includes Lea, Pata"). An app before W4
ignores `fields`.

## 3. The outbox (format 1)
The addon writes it, typically on `PLAYER_LOGOUT` (which also fires on `/reload`). The file is Lua source; the app
**parses it as data** and never runs it, so keep it to plain tables, strings, numbers and booleans.
```lua
JourneyTogetherForeverDB.webhooks = {
  format = 1,                    -- this section's version
  groups = {
    ["Player-1-Victor-1800000000"] = {   -- the group's id: stable, unique on the account
      name = "Iron Oath",                -- shown in the app, and the posts' sender name
      sub = "Led by Victor · 5 Adventurers",   -- one line under the name in the window (optional)
      saved = 1800000000,                -- time() when the addon wrote this group (Unix seconds)
      by = "Victor-Realm",               -- whose game wrote it (shown as "saved … by Victor")
      color = "2A5BB8",                  -- optional: a colour for the group in the window
      kept = {                           -- one entry per kept kind (manifest ids)
        board = {
          text = "Iron Oath  ·  Chapter 2 of 15  ·  15-21  ·  Waiting for the floor",   -- the line with the picture
          data = { ... },                -- given to the template as it is (Journey Together: today's board table)
        },
      },
      news = {                           -- newest first; keep the last 20 or so
        { id = "run:hot:1800000000:", kind = "clear", time = 1800000000,
          text = "Hall of Thanes cleared by Victor, Mira and Pata.",
          name = "Hall of Thanes",       -- the short name the weekly summary lists
          picture = "art/dungeon-hot.jpg",     -- optional: a file in the Webhooks folder, or "Media/x.tga" from the addon
          fields = { dungeon = "Hall of Thanes", who = { "Victor", "Mira", "Pata" } } },   -- optional: values for Only when
        { id = "run:dm:1799990000:", kind = "clear", time = 1799990000, text = "The Deadmines cleared by Victor and Mira.",
          picture = { game = 131833, crop = { 0, 1, 0.26, 0.78 }, aspect = 2.56 } },   -- a picture from the game
        { id = "picture:Victor-Realm:1799995000", kind = "picture", time = 1799995000,
          text = "Hall of Thanes: a picture with Victor, Mira and Pata.",
          screenshot = 1799995000 },     -- optional: the game's screenshot taken then is attached
      },
      numbers = { Victor = 19, Mira = 18, Pata = 17 },   -- optional: what the weekly summary follows (§5)
    },
  },
}
```
- **`id`** of a news item never changes once written: the app remembers which ids each channel posted.
- **`time`** says when it happened. A line drawn later does not bring older news.
- **`picture`** may also be one of the game's own pictures (from the app's W6), which an addon may not ship:
  `{ game = <file id>, crop = { left, right, top, bottom }, aspect = <width / height> }`. The app reads that file from
  the player's game (`docs/SPEC.md` §7.1), cuts out the part `crop` names (each 0 to 1 of the file, as the game's
  `SetTexCoord`), and posts it at the shape `aspect` names (a 4:3 loading screen is stored square, for one).
  `crop` and `aspect` are optional. The game version the group was saved in is the one read; when it does not have
  the file, the text goes without it. An app before W6 posts the text without it.
- **`screenshot`** (news only, from the app's W4): `time()` when your addon called `Screenshot()`. The game saves the
  file in its Screenshots folder by the computer's clock, at that second or a little later; the app finds it by that
  time and attaches it. Write it only for a screenshot the player chose to take for this (Journey Together: Take a
  picture), and give the kind `default: false`: the player draws it to a channel when they want their screenshots
  posted. Only screenshots taken on this computer can be found, so each player's app posts only that player's.
- **Where posts go** is the player's choice (flows, `docs/SPEC.md` §5.1). A plugin offers kinds and never picks
  channels.
- A kept entry is edited in Discord when its group's `saved` is newer than what that channel last showed.
- A group that is no longer in the outbox (left the fellowship) stops posting; its old messages stay in Discord.
- `text` is at most 1900 characters after the app escapes Discord formatting; longer is cut with "…".
- No secret values: SavedVariables never hold them, but do not write values you read during combat without checking.
- **Only one player should post a group.** Two players running the app for the same channel post everything twice.
  Let your addon decide who writes the outbox (Journey Together: whoever runs the app; Guild Hall: the Herald).

## 4. Changing the outbox
- **Adding** a field: allowed, `format` stays; the app ignores fields it does not know.
- **Renaming, removing or changing the meaning** of a field is the app's business, not yours: the outbox `format` only
  changes with a new app version, and the app keeps reading older formats.
- Your own `data` for a template is yours: change it with your template, in the same addon version.

## 5. Weekly summary
With `weekly` in the manifest, the summary is one more kind under each group on the Flows page, and lines decide
where it goes (its kind id is `weekly`, so a plugin's own kinds may not use that id). Each day the app keeps a copy of
each group's `numbers` (15 days).

On Sunday at 20:00 it posts, per group, these parts joined with `separator`:
- the head line;
- each number that changed since the last summary (`number`, highest change first);
- for each `news` entry, the names of that week's items of that kind (`{list}`, joined with ", ").

If nothing changed, nothing is posted.

## 6. Picture templates
An HTML page in the Webhooks folder that draws one picture from `data`. It must define:
```js
window.webhookCard = {
  // Draw the picture for one kept entry (or news item) and resolve with the element to capture,
  // once its pictures have loaded.
  async render(data, ctx) { ... return document.getElementById('card'); },
};
```
`ctx` is `{ now, group: { id, name, color }, asset(path), game(fileId) }`; `asset("art/x.jpg")` or
`asset("Media/x.tga")` gives a URL the page may load, or `null` when the file is missing (then draw without it).
`await game(131833)` (from the app's W6) gives a URL for one of the game's own pictures, read from the player's game
(`docs/SPEC.md` §7.1) as a PNG of the whole file, or `null` when that game does not have it; at most 40 per picture.
Crop it yourself (Journey Together: board.js). Ask before you draw, and check `typeof ctx.game === 'function'` for
older apps. Name the file ids in your data, as your addon uses them in the game. The page:
- loads only its own files (no network, no fonts or scripts from the web);
- is drawn at 1000 CSS pixels wide by default (`"width"` in the manifest's template entry to change it), at most
  1600 × 2400 pixels;
- is opened fresh for every picture, so it may keep no state.

## 7. Code plugins
For an addon that does not write an outbox (someone else's addon, an old one), a code plugin can make one from the
addon's own saved data (from the app's W7, 30 Oct 2026). It is a `.zip` with `webhooks.json` and a script, at the
top of the zip or in one folder inside it (a zipped folder):
```json
{ "contract": 1, "id": "my-plugin", "name": "...", "author": "...", "version": "1.0.0", "for": "SomeAddon",
  "savedVariables": "SomeAddon", "script": "plugin.js", "group": "character", "kinds": [ ... ] }
```
```js
// plugin.js: runs in a sandbox with no Node.js, no network and no files.
// saved: the parsed SavedVariables file (all its globals). last: what this function returned last time, or null.
// Return an outbox as in §3 (without the Lua): { format: 1, groups: { ... } }.
export default function build(saved, last, ctx) { ... }
```
`ctx` is `{ now }`. It has 5 seconds. The player installs it by hand, after the warning in `docs/SPEC.md` §3; the app
never installs or updates a code plugin by itself.
- **The manifest** is a data plugin's (§2) with `script` (a `.js` or `.mjs` file in the zip) and `for` (the addon's
  folder name, shown to the player) instead of `outbox`; no `copies`. `templates`, `fields`, `weekly` and `empty`
  work as for a data plugin, with the template's files in the zip.
- **The script** is an ES module. It may import its own files by relative path (`import { x } from './lib.js'`) and
  fetch its own `.json` files; nothing else loads. A request to the internet stops it.
- **`saved`**: every global the SavedVariables file sets, as plain data. Lua tables with only the keys 1..n (or none)
  are arrays; other tables are objects, number keys as strings.
- **`last`**: exactly what it returned the last time it ran on that game and account, or `null` (the first time, or
  when that was over 4 MB). Keep your own fields in it (the app ignores fields it does not know): that is how a
  script tells what changed, such as a level gained. Keep `news` items with the same `id` from one run to the next;
  the app posts each id once.
- **Return** an outbox as in §3, or `null` for nothing to post. Texts are plain, as for any addon: Discord
  formatting is shown as typed, not applied.
- **It runs** when the addon's saved data changed (a logout, `/reload`) and when it is installed again; one script at
  a time.
- **Stopped, and named** on the player's Addons tab: a request to the internet, reaching for Node.js (`require`),
  more than 5 seconds, an error thrown, or an answer that is not an outbox. Nothing is posted from that game until it
  runs well again.

A sample: `test/fixtures/code/simple-scores` in the app's repository, for a made-up addon that saves levels and
kills. It keeps a kept message of every character and posts a level gained, found by comparing with `last`.

## 8. Checking your plugin
The app has a check mode that reads a SavedVariables file you name and shows every group, kept message, news item
and picture as it would post them. It posts nothing, needs no Discord channel, never writes in the WoW folder and
runs beside the app if that is open.
```
"%LOCALAPPDATA%Programswow-addon-webhooks-for-discordWoW Addon Webhooks for Discord.exe" --check "<WoW>_retail_WTFAccount<ACCOUNT>SavedVariables<Addon>.lua"
```
- **The plugin**: without `--plugin`, the one in the addon of the same name, in the same game version
  (`InterfaceAddOns<Addon>Webhooks`), with its `copies` for a copy of the addon saving under another name.
  `--plugin "<folder>"` names another, such as a code plugin's unpacked folder (its script runs as in the app).
- **The report**: the plugin and its problems; each group with its kept messages and their pictures (game art
  included), its news items with their pictures and the screenshot each names (found or not); the fields of each
  item, and the weekly numbers.
- **Where**: a window, and `report.html` and `report.txt` with the pictures, in `%TEMP%WoW Addon Webhooks check`
  or the folder `--out "<folder>"` names (only the check's own earlier files there are replaced). `--quit` saves it
  without the window. While developing the app: `npm start -- --check "<file>"`.
