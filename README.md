# Keystone

A mod control panel for single-player PC games. Load a Cheat Engine table for a game and its values become switches you can lock or set from a clean desktop app.

**Mods and online games:** memory mods are for offline and single-player play. Keystone reads and writes another program's memory the same way Cheat Engine does, and it never hides from, bypasses or works around anti-cheat.

- Games with an offline or solo mode are flagged **Offline only**. Their mods stay off until you turn on **Use mods in this game** and accept the warning, and Keystone doesn't touch the game's memory at all while they're off.
- Games with no offline mode never get mods. Their Library, commands (where the game has them), map and overlay still work, because none of those touch the game.

## Install

**The easy way: the installer.** Run `Keystone Setup <version>.exe`. It installs for your Windows account only (no administrator needed) and adds Keystone to the Start menu and desktop.

Unless the release was built with code signing set up, Windows shows *"Windows protected your PC"* the first time. Click **More info**, then **Run anyway**. That's the prompt every unsigned app gets. The release workflow signs installers automatically once Azure Artifact Signing is set up; [docs/SIGNING.md](docs/SIGNING.md) walks through it (about $10 a month).

**Updating:** run the newer installer. It replaces the old version and keeps all your settings, profiles, waypoints and command setup (they live in `%APPDATA%\Keystone`).

**Uninstalling:** Windows Settings → Apps → Keystone. Your settings folder stays behind in case you reinstall; delete it by hand if you want a clean slate.

### Getting the installer

- **From GitHub (recommended):** push a version tag and GitHub builds it on a Windows machine:
  ```bash
  git tag v0.7.0
  git push origin v0.7.0
  ```
  When the **Build installer** action finishes, the installer is on the repo's **Releases** page.

  Release zips hold everything inside a top-level `keystone/` folder. Its *contents* go at the root of your repo (next to `.github/`), not the folder itself. The build checks that the tag matches the version in `package.json` and stops with an explanation if it doesn't, rather than publishing an old installer under the new tag.
- **On your own PC:** `npm install`, then `npm run dist`. The installer lands in `dist/`.

### Running from source (for development)

Needs Node.js 20 or newer:

```bash
npm install
npm start
```

Run the tests with `npm test`.

## Everyday use

- Start Keystone from the Start menu or desktop shortcut.
- **Closing the window keeps Keystone running in the system tray** (bottom-right, near the clock), so the overlay, phone remote and hotkeys keep working while you play. Click the tray icon to bring the window back; right-click it to turn the overlay or phone control on or off, or to **Quit Keystone**.
- In **Settings** you can turn on **Start Keystone when Windows starts** (it starts quietly in the tray) or turn off the tray behavior so closing the window quits.
- Launching Keystone while it's already running just brings the open window forward.

## Using it

**Games** (the home screen) shows every game Keystone has a pack for, with its cover art. Games installed on your PC (found in Steam, the Epic Games Launcher, GOG Galaxy and the Xbox app) come first and say which store they're from; the **All / Installed / Running** tabs filter the list. Pick one to open its page:

- **Play** starts the game through the store it's installed from, and Keystone connects as soon as it's running.
- Started the game some other way? Keystone notices it within a few seconds and connects (turn this off in **Settings → Attach to games automatically**). It won't switch away from a game page you have open, and if you close a running game's page, it leaves that game alone until it restarts.
- Tabs across the top: **Mods**, **Commands**, **Library**, **Map & overlay**.
- The **×** closes the game page.

Games without a pack are under **Other running programs** on the home screen; pick one and load your own Cheat Engine table.

### Mods

Mods are grouped like the cheat table's groups, with tabs to show one group at a time. Each mod has the control that suits it:

- **Off / On**: On keeps the value where it is (or at the number in the box).
- **Value box + Apply**: writes the number once and lets the game keep changing it.
- **Slider**, **steps** (like 1K / 10K / 100K) and one-tap **Apply** buttons where the game's pack sets them up.

**Saved mods** stores which mods are on and their values, per game, and can turn them back on when the game starts.

**Hotkeys:** hover a mod and click **+ Key**, then press the keys you want (F-keys and numpad keys work alone; letters and digits need Ctrl or Alt so typing in game chat can't trigger them). A hotkey switches the mod on and off, steps through its values, or applies it, and works while the game is in front. The result flashes in the overlay. Hotkeys are only active while Keystone is connected to that game's mods.

**Pins:** hover a mod and click the pin. Pinned mods get their own **Pinned** tab and show in the overlay's **Mods** panel with their hotkeys and On/Off state (click them there while editing the overlay layout).

Mods show **Waiting for the game** while their address can't be read, which is normal on loading screens and main menus. Locked mods stay locked and start writing again as soon as the game is back.

**Table store.** Open **Tables** in the sidebar for community cheat tables, one card per table with the game's cover. Click a card and the table's own page opens in Keystone's browser (FearLess Revolution needs a free account; log in there once and the browser remembers it). Download the table on that page as you normally would: Keystone catches the file (a `.CT`, or a `.zip` with `.CT`s in it), checks it really is a cheat table, and puts it in that game's Tables folder with credit to its maker. It loads by itself whenever the game starts, or straight away if the game is already open. Keystone never hosts the files; every download comes from the creator's page.

Installed tables are checked for updates about once a day. Keystone opens each table's page in the background, using the browser's login, and looks for a newer file in the first post. A new version gets an **Update** badge on its card, a count on **Tables** in the sidebar, and one Windows notification. **Get update** opens the page again, and the new file replaces the old one even if its name changed. **Check for updates** checks right away. If the page asks you to log in, or Cloudflare's browser check doesn't pass on its own, Keystone skips it and tries again the next day. **Remove** deletes a table from your PC. The list of tables is `tables/store.json`.

**Tables that load by themselves.** Put a table in `tables/<game>/` in this repo and it ships in the installer and loads whenever that game starts, so mods work right after installing. `<game>` is the pack's folder name (like `fallout-4`). A `credits.json` next to it names who made each table, shown under the mods list (see `tables/README.md`). Tables for one PC only go in that game's **Tables folder** (button on the Mods tab, `%APPDATA%\Keystone\tables\<game>\`) and never end up in a build.

**Making your own mods (Find a value).** No table for your game? Click **Find a value** on the Mods tab:

1. Type a number the game shows (your caps, ammo, gold) and press **First scan**.
2. Change it in the game, then search for the new number, or for **Went up** / **Went down** / **Went down by**, and press **Next scan**. Repeat until a few are left. **Undo** steps back one scan.
3. Click **Add as mod** on the one that matches and name it. It joins the mods list under **My mods**, with the usual On/Off, value box, hotkeys and pins.

Decimal values (health bars, stamina) are found with **Decimal** as the kind of number; a typed "72.3" matches whatever the game rounds to 72.3.

Where the value lives decides how long the mod lasts. Values inside the game's own files show as **Saved** (like `Game.exe+1A2B3C`): they're kept, come back every time you open the game, and can be shared. Most values are on the heap instead and show **Until the game closes**: the address changes every launch, so the mod works for this session only. (A pointer finder that makes those last is next.)

**Sharing:** **Share as table** saves your saved mods as a Cheat Engine table. A friend loads it with **Load table** (Keystone remembers it), and Cheat Engine opens it too. To ship mods with Keystone itself, put the file in the game's pack folder as `mods.ct`: a pack loads its `mods.ct` automatically.

### Library

Each game's knowledge in one place. Open **Library** in the sidebar.

- **Browse** creature and item pages: category, map, the IDs admin commands need (with Copy buttons), and buttons that jump straight to Commands with that creature or item picked.
- **Guides** written for the game, plus your own: drop Markdown (`.md`) files in your guides folder (**Library → All guides → Open my guides folder**) and they show up next to the pack's guides.
- **My notes** on any creature or item, saved per game.
- **Search** covers everything at once.
- **Tools**: Phasmophobia has a **Ghost identifier**: tick the evidence you find or rule out, set how much evidence the difficulty gives, and it narrows the 30 ghosts down, allowing for hidden and guaranteed evidence and the Mimic's fake orbs. It's on your phone and in the overlay too.
- **Pictures** (ARK, Fallout 3, New Vegas, Fallout 4): every creature and item has its picture in the lists and on its page (creature pages show the dossier), and creature pages show **Where it spawns** on each map. The pickers in Commands show them too. They come from the ARK Wiki: your PC downloads each one the first time you look at it and keeps a copy, so they load instantly after that and work offline. Variants without their own picture (Abyssal, Alpha, X- creatures) use the base creature's. Fallout's come from the Fallout Wiki on Fandom: most Fallout 3 and New Vegas items, and about 70% of Fallout 4's (the wiki has no picture for the rest).

### Browser

Keystone has its own small web browser for wikis and guides, so you can read without alt-tabbing.

- **Ctrl+Shift+B** shows or hides it, over your game too (borderless or windowed mode). **Esc** hides it.
- Creature and item pages have **Open on ARK Wiki**, and the Library lists the game's useful sites.
- It stays on top of the game by default (the pin button toggles that); the **⋯** menu makes it see-through and sets a start page.
- It remembers its size and position, and keeps you logged in to sites between sessions. Websites run isolated from Keystone and can't reach any of its settings or controls.

### Commands (ARK: Survival Ascended first)

Pick what you want, set the details, and Keystone runs the admin command for you.

1. Open the game switcher and pick **ARK: Survival Ascended** under **Your games**. It works whether or not the game is running.
2. Open **Commands** in the sidebar, then **Settings**:
   - **Game console**: the key that opens ASA's console (Tab by default), the prefix (`admincheat` on servers), and your server's admin password.
   - **RCON**: your server's address, RCON port and admin password, then **Test connection**. The server needs `RCONEnabled=True` and an `RCONPort` in its settings (most hosts have these in their control panel).
3. In game, press **Log in as admin** once per session. Keystone types `EnableCheats` for you.
4. Pick a tab:
   - **Creatures**: search, pick a creature, choose **Spawn tamed** (set the level) or **Spawn wild**, how many, and press the button.
   - **Items**: pick an item, then **Give to me** (quantity, quality, blueprint) or **Give to a player** over RCON.
   - **Quick commands**: god mode, fly, infinite stats, time of day, save the world, message everyone and more.
   - **Type a command**: anything else, through the console or RCON.

The box above the button always shows the exact command that will run. Recent commands, with the server's replies, are listed underneath.

How commands reach the game:

- **Game console** commands act on your character (spawning next to you, giving yourself items). Keystone switches to the game, opens the console, types the command and presses Enter. It's the same as typing it yourself; it doesn't touch the game's memory, so it works on BattlEye servers. If keys get dropped, switch **How to enter commands** to **Paste them**.
- **RCON** commands go straight to the server over the network and work even when the game isn't running.

Passwords are stored encrypted with your Windows account's key.

When a game's memory can't be read (anti-cheat), Keystone still selects it: Mods are unavailable, but Commands, the map and waypoints work.

### Saved mods

A saved set records which mods are on and the values in their boxes, per game.

- **Save these mods** stores the current setup under a name. After that, **Save** updates it and **Save as new** makes a copy.
- Pick a profile from the list to apply it. Mods the profile doesn't lock get unlocked.
- **Unsaved changes** appears when your locks differ from the selected profile.
- In the **⋯** menu, **Turn these mods on when the game starts** (on by default) re-applies them the next time the game is connected.
- Keystone also remembers which cheat tables you loaded for each game and reloads them on attach, so profiles always have their mods available.

Settings live in `%APPDATA%\Keystone\games\<game>.exe.json`.

### Phone remote

Toggle mods from your phone while you play.

1. Open **Phone** in the sidebar and turn on **Allow phone control**.
2. Connect your phone to the same Wi-Fi as the PC and scan the QR code with its camera.
3. Add the page to your home screen so it opens like an app (iPhone: Share, then Add to Home Screen; Android: the ⋮ menu, then Add to Home screen).

The phone has up to four tabs, depending on the game:

- **Mods:** flip a switch to lock a mod, tap a mod's name to set or lock a specific value, and pick a profile at the top to apply it.
- **Map:** the game's map with its marker layers (tap the chips to show or hide them), your waypoints and where you are: a live arrow when Keystone reads your position, or your "I'm here" ring. Drag to move, pinch or use + and − to zoom, ⛶ for full screen (good in landscape). Tap a spot, marker or waypoint to teleport there (games with teleport), add a waypoint, track it, delete it, or mark "I'm here". ARK has **Find me**. The waypoint list under the map shows how far each one is, with Track and Go buttons.
- **Library:** the same Library as the desktop: search, every section with pictures and a filter, entry pages with their facts, codes (with Copy), ARK spawn maps, a link to the wiki page, and your notes (they save to the PC). Guides read on the phone too. The phone's back gesture steps back through the pages.
- **Tools:** commands (games with a console or RCON: the pack's quick commands, admin login and a box to type any command), timers, your checklists (pick which one; the overlay shows the same one) and the ghost identifier. In the Library, creatures and items have their commands right on the page: **Spawn tamed**, **Spawn wild**, **Give to me**, with the same form as on the PC.

Everything stays in sync with the desktop window: a waypoint added on the phone is on the overlay too, and the marker filter is the same one.

Things to know:

- The first time you turn it on, Windows asks whether Keystone can use private networks. Allow it.
- It's a web page served by Keystone (port 47800 by default), not an app-store app, and it only works on your home network. Nothing goes through the internet.
- The QR code holds a pairing code. Only phones that scanned it can control mods. **Reset pairing** (under Connection settings) unpairs every phone at once.
- If your PC's network address changes, phones need to scan again. Reserving the PC's address in your router's settings avoids that.
- Phone control is off by default and remembers its on/off state.

### In-game overlay

A minimap, waypoints, live stats and info cards drawn on top of your game.

1. Open **Overlay** in the sidebar and turn on **Show overlay**.
2. Under **Where you are**, pick the mods that hold your X and Y coordinates (height and facing are optional; facing turns the minimap arrow).
3. Under **Map**, click **Choose map image** (a screenshot of the game's world map works), then **Line up the map**: stand somewhere recognizable in game and click that spot on the map, then do it again somewhere far away. Two clicks is all it needs.
4. Pick **Stats to show** and add **My notes** if you like.

Hotkeys while playing:

| Keys | Does |
| --- | --- |
| Ctrl+Shift+O | Show or hide the overlay |
| Ctrl+Shift+E | Edit layout: drag panels; on the minimap, **Pin** adds a waypoint where you click and **Here** marks where you are; right-click teleports, scroll zooms |
| Ctrl+Shift+W | Drop a waypoint where you're standing |
| Ctrl+Shift+G | Teleport to the tracked waypoint |
| Ctrl+Shift+F | Find me (ARK; only registered while ARK is selected) |

#### Without mods: online games, BattlEye servers

The map works without reading the game at all:

- **I'm here:** click **I'm here** under *Where you are*, then click your spot on the map (or use **Here** on the minimap while editing the overlay). The marker is a ring, not an arrow: it stays where you put it until you set it again.
- **Marker layers:** game packs can add points of interest (ARK's Island has its artifact caves and artifacts). Turn each layer on or off under the map.
- **ARK Find me:** press **Find me** or Ctrl+Shift+F in game. Keystone types `ccc` into the console (you need to be logged in as admin), reads the position ARK copies to the clipboard, puts your clipboard back, and drops the marker on your map in the lat/lon the in-game map uses. Pick which ARK map you're on in the *Map* list.
  - ARK: Survival Ascended's map screen uses different numbers from the older GPS coordinates, and the conversion isn't published. The Island uses a scale worked out from cave locations both ways; the other maps start from the ARK: Survival Evolved values. If the marker lands in the wrong spot, open **Marker in the wrong spot?**, type the lat/lon your in-game map shows, and Keystone fixes the scale for that map.
- A lat/lon map draws a grid until you add a picture. A screenshot of the whole in-game map usually lines up without any clicks; if not, **Line up the map** works with Find me: Find me, click your spot, move far away, Find me, click again.

Waypoints can be renamed, moved, tracked (distance and direction show under the minimap), teleported to and deleted in the Overlay tab. The phone remote lists them too, with a **Go** button each.

**Teleporting** writes your position through the game's position mods, so it needs mods connected and the X and Y position mods set in the Overlay tab (game packs set them for you). It holds the new spot for a moment so the game doesn't pull you back. If the waypoint has no height saved, you keep your current height, so on hilly maps you may land inside a slope; walk or jump out. Games with a teleport console command can use that instead, and then it works without mods. Offline-only games follow the same rule as other mods: off until you turn mods on for that game.

#### Timers and checklists

- **Timers:** add them in the Overlay tab with a name and a length (`15m`, `1h 30m`, `2:30`, or just `10` for ten minutes); tick **Repeat** for things that come round again. They show in the overlay's Timers panel, and when one runs out you get a chime and a flash in the overlay, a toast on your phone, and a Windows notification. Timers are app-wide and keep counting while you switch games or close Keystone (one that ends while Keystone is closed shows as done, without a late alert).
- **Checklists:** per game. Game packs can bring starters (ARK has the Island's artifacts and bosses); add your own, tick items, untick all for a new run. The one you pick is shown in the overlay and on your phone.
- Start or pause a timer, or tick an item, from the overlay by clicking it while editing the layout, or from the phone remote at any time.

#### Crosshair and PC stats

- **Crosshair:** under *Crosshair* in the Overlay tab: cross, cross + dot, T, dot or circle, with size, thickness, gap, opacity, colour, a dark outline, and a nudge if the game's centre isn't the screen's. Saved per game. It's drawn by Keystone's overlay window, so it works in any game that runs borderless or windowed. Some competitive games don't allow crosshair overlays; check before using one there.
- **PC stats:** turn on the *PC stats* panel to see CPU use, RAM, the time, and how long you've been playing. These come from Windows, never from the game.

Notes:

- Run the game in **borderless** or **windowed** mode. Exclusive fullscreen draws over every other window, including the overlay.
- By default the overlay only shows while the game is the window in front, so it disappears when you alt-tab.
- The overlay is a separate see-through window. It never touches the game's rendering, so there's nothing for anti-cheat to flag on that front.

### Game packs

A pack bundles what Keystone should know about a game: its cheat table, map, where the position values are, starter waypoints, info cards, commands, and Library sections and guides. Packs live in `packs/` (bundled) or `%APPDATA%\Keystone\packs\` (yours). Each pack is a folder with a `pack.json`; see `packs/demo/pack.json` for every field. Everything is optional, and anything you change in the app wins over the pack.

No game handy? Click **Try the demo game**. It's a fake game inside Keystone whose health drains, ammo runs down and position wanders, so you can see locking work.

### If attaching fails

- **"Windows denied access"**: the game is running as administrator. Run Keystone as administrator too.
- Games with kernel anti-cheat (EasyAntiCheat, BattlEye, Vanguard and similar) will refuse. That's expected.

## What works from a Cheat Engine table

| Table entry | Status |
| --- | --- |
| Address or pointer with type Byte, 2/4/8 Bytes, Float, Double | Supported: lock and set |
| Group headers and nested entries | Supported |
| Addresses like `game.exe+1234`, `"Game Assembly.dll"+10`, `[game.exe+20]+8` | Supported |
| Auto Assembler scripts (Cheat Engine's templates: AOB injection, code caves, NOP patches, "get pointer" scripts) | Supported: On runs [ENABLE], Off runs [DISABLE] |
| Addresses using symbols a script registers (e.g. `pPlayer`) | Supported once that script is on |
| Scripts using Lua (`{$lua}`, `luacall`), `createthread`, `loadlibrary`, `include` | Listed with the reason, not runnable |
| Strings, byte arrays, custom types | Listed, not supported yet |

**Scripts in detail.** Keystone runs `aobscanmodule`/`aobscan`/`aobscanregion`, `alloc`/`globalalloc` (placed near the game's code so a 5-byte jump reaches it), `dealloc`, `label`, `registersymbol`/`unregistersymbol`, `define`, `assert`, `fullaccess`, `db`/`dw`/`dd`/`dq`, `nop N`, `readmem` and `reassemble`, plus x86-64 instructions in Cheat Engine's syntax (numbers are hex unless `#decimal`; `(float)100` gives a float's bits). A script runs all-or-nothing: if any part fails, nothing it wrote stays and its memory is freed, and the error shows under the mod (for example "Couldn't find the code this script changes", usually meaning the game updated since the table was made). Scripts that are on are switched off when Keystone lets go of the game, so it's never left with a patch nobody manages.

Only use scripts in games where mods are allowed: they change the game's code, which anti-cheat looks for.

## Project layout## Project layout

```
src/main/            Electron main process
  main.js            windows, IPC, single instance, start with Windows
  art.js             game cover and banner art (Steam CDN, cached)
  installed.js       finds installed games (Steam, Epic, GOG, Xbox app)
  hotkeys.js         per-mod hotkey rules and registration
  tray.js            system tray icon and menu
  library.js         Library: catalog pages, Markdown guides, notes, search
  library-images.js  Library pictures and spawn maps from the game's wiki (cached)
  browser-window.js  Keystone's browser window (Ctrl+Shift+B)
  controller.js      app actions, shared by every UI
  store.js           per-game settings and profiles on disk
  settings.js        app-wide settings (phone remote, overlay)
  packs.js           game packs
  overlay-model.js   overlay data: position, map, waypoints, checklists, stats
  timers.js          countdown timers and their alerts
  identify.js        "what is it?" tools, like the Phasmophobia ghost identifier
  finder.js          value finder and My mods (saved, session-only, shared as a table)
  tables.js          tables that load by themselves (bundled and per-PC) and their credits
  table-store.js     Tables tab: catalog, installing downloads (.CT/.zip), update checks' page reading
  table-fetch.js     Tables tab, Electron side: catches downloads in the browser, background update checks
  pcstats.js         CPU and RAM for the overlay's PC panel
  overlay-window.js  the see-through overlay window and its hotkeys
  commands/
    model.js         command templates, validation, history, routing
    console-sender.js  types commands into the game console (SendInput)
    rcon.js          Source RCON client for game servers
  remote/
    server.js        LAN web server + WebSocket for the phone
    network.js       picks the PC's home-network address
    index.js         pairing, QR code, on/off
  engine/
    win32.js         kernel32 bindings (koffi FFI, no native build)
    win-memory.js    read/write a real process
    process-list.js  running programs
    ct-parser.js     Cheat Engine .CT -> mod records
    address.js       address expressions and pointer chains
    values.js        value types
    session.js       attached game: lock loop, live values
    scanner.js       memory scans for the value finder (first/next scan, undo)
    asm.js           x86-64 assembler for Cheat Engine syntax (encoding by iced-x86)
    autoasm.js       runs Cheat Engine Auto Assembler scripts ([ENABLE]/[DISABLE])
    demo-game.js     fake game used by the demo and tests
src/renderer/        desktop UI
src/remote-web/      phone web app (served to the phone by remote/server.js)
src/overlay/         overlay page (minimap, stats, info)
src/browser/         the browser window's toolbar page
assets/              app icons
src/shared/          shared styles, accent themes, Geist fonts (OFL), map math, crosshair drawing
tables/             bundled cheat tables, loaded by game (see tables/README.md); store.json lists the Tables tab
packs/demo/          the demo game's pack: table, map, waypoints, info
packs/ark-survival-ascended/  ASA pack: commands, creature and item IDs, guides
packs/fallout-3/     Fallout 3 pack: console commands, 714 base-game items, bobblehead checklist, guides
packs/far-cry-*/    Far Cry 3, 4, 5, 6, New Dawn, Primal: weapons, vehicles and animals with pictures; mods flagged offline-only
packs/forza-*/      Forza Horizon 4, 5, 6 (mods offline-only) and Forza Motorsport (online-only, no mods): every car with pictures
packs/fallout-shelter/  Fallout Shelter: dwellers, weapons, outfits, pets and rooms with pictures; legendary dweller checklist
packs/lego-*/       LEGO packs (Star Wars: The Skywalker Saga, Star Wars: The Complete Saga, Batman 2): cross-checked codes
packs/phasmophobia/  Phasmophobia pack: ghost identifier data, ghosts, equipment, cursed possessions, maps, incense timers, guides
packs/fallout-new-vegas/  New Vegas pack: console commands, 1,100+ base-game items, snow globe checklist, guides
packs/fallout-4/     Fallout 4 pack: console commands, 648 base-game items, guides
scripts/build-gamebryo-catalog.js  rebuilds the Fallout 3 / New Vegas item lists from the wiki
scripts/add-wiki-pictures.js       fills in each catalog entry's picture file from its wiki infobox
scripts/build-category-catalog.js  builds a Library list from wiki categories (used for Far Cry)
scripts/build-forza-cars.js  builds a Forza car list from the Forza Wiki's car tables
scripts/build-fallout-shelter.js  builds the Fallout Shelter lists from Nukapedia's overview tables
scripts/build-phasmophobia.js      rebuilds the Phasmophobia ghost, equipment and map lists from the wiki
test/                node:test suite
scripts/capture.js   dev helper: launch, run a snippet, save a screenshot
.github/workflows/   builds the Windows installer when a version tag is pushed
```

## Changelog

### 0.29.0
- **Table store**: a new **Tables** tab lists community cheat tables for Keystone's games as cards with cover art. Click one, download the table on its creator's page in Keystone's browser, and it installs itself into that game's Tables folder, with credit, and loads with the game (or right away if the game is open). `.CT` and `.zip` downloads work; anything else is explained and left to the normal save dialog. Nothing is redistributed: every file comes from the creator's own page.
- **Update alerts**: installed tables are checked about once a day using the browser's login. Newer files show as **Update** on the card, a count on the sidebar and a Windows notification (once per new file). Updates replace the old file. **Check for updates** and **Remove** on the tab.
- 26 tables to start, across 16 games, all on FearLess Revolution.
- Keystone's browser no longer adds "Electron" to its user agent, which some sites' bot checks objected to. It can show a short message across the top (used for "Installed …").

### 0.28.0
- **Cheat Engine scripts work.** Auto Assembler scripts in tables now switch on and off like any mod (and take hotkeys, pins and the phone switch): code injections and caves, NOP patches, AOB scans, symbols and the rest of Cheat Engine's templates. Values that read through a symbol a script registers (`[pPlayer]+10`) work once that script is on. Scripts that need Lua say so instead of half-running.
- Scripts run all-or-nothing and undo themselves if anything fails; the reason shows under the mod. Scripts that are on are turned off when Keystone lets go of the game.
- The demo table has two real scripts, **God mode** (a NOP patch) and **Infinite ammo** (Cheat Engine's code-cave template), and the demo game honours them.
- Saved mods (profiles) include scripts and turn them on before the values that depend on them.

### 0.27.0
- **Bundled tables**: tables in the repo's `tables/<game>/` folder ship in the installer and load by themselves when the game starts, with credit to their makers from `credits.json` shown under the mods list.
- **Tables folder**: a per-game folder on each PC (button on the Mods tab) for tables that load by themselves on that PC only.

### 0.26.0
- **Find a value**: make your own mods without Cheat Engine. Search the game's memory for a number it shows, change it in game, scan again (exact value, went up/down, went up/down by, changed, unchanged, between), and add the match as a mod. Scans run in the background with progress and Cancel, and Undo steps back a scan.
- **My mods**: mods you make join the mods list with all the usual controls. Ones in the game's static memory are saved and come back every launch; ones on the heap last until the game closes, and are marked that way.
- **Share as table** saves your mods as a Cheat Engine table a friend can load, and a pack ships mods by having a `mods.ct` in its folder.
- The demo game has a day counter in static memory, so you can try a saved mod there.

### 0.25.0
- Fallout Shelter pack: the Library has all 100 rare and legendary dwellers (legendaries with their SPECIAL, weapon, outfit and home game), 249 weapons, 179 outfits, 62 pets and 28 rooms, with pictures. The pack also has a guide, a Legendary dwellers checklist (all 53) and Steam art. Mods work from a Cheat Engine table as usual; it's single-player, so there's no offline-only flag, but the guide says to back up your vault saves first.

Fallout Shelter data and pictures come from [Nukapedia](https://fallout.fandom.com) on Fandom; the executable name from Steam's launch configuration.

### 0.24.1
- Code signing, ready to switch on: the release workflow signs the installer with Azure Artifact Signing when the repo has the signing secrets and variables, checks the signature before publishing, and builds unsigned (as before) when it doesn't. A half-finished setup stops the build with a message saying what's missing, rather than quietly shipping unsigned. Setup steps are in `docs/SIGNING.md`.

### 0.24.0
- Phone commands: games with commands (ARK, Fallout) get a **Commands** section in the phone's Tools tab with the pack's quick commands, admin login and a box for typing any command, over the console or RCON. Library pages for creatures and items have **Spawn tamed**, **Spawn wild** and **Give to me** buttons that open the same form as on the PC (level, how many, quality...).
- The PC still builds and checks every command; the phone only picks one and fills in the form. Your admin password never goes to the phone.

### 0.23.1
- Phone checklists: when a game has more than one checklist, the phone's Tools tab has a picker. Picking a list there also changes the one the overlay shows, the same as picking it on the PC.

### 0.23.0
- Phone Library: a **Library** tab on the phone with search, every section (with pictures and filters), entry pages, codes with a Copy button, ARK spawn maps, wiki links, guides and your notes. Notes typed on the phone save to the PC.
- Pictures come from the PC's own cache over your home network, never from the wiki directly, with the pairing code in a header as for the map.

### 0.22.0
- Phone map: a **Map** tab on the phone with the game's map, marker layers you can filter, waypoints, and your live position or "I'm here". Drag, pinch, zoom buttons and full screen. Tap anything on the map to teleport there, add or track a waypoint, or set "I'm here"; ARK's Find me works from the phone too. It works for online games as well (map, markers and "I'm here"; teleport still needs mods).
- The phone is now split into **Mods**, **Map** and **Tools** tabs instead of one long page. The Teleport list moved into the Map tab.
- The map picture comes over your home network once per picture, using the pairing code in a header (never in the address), with the same lockout for wrong codes as the rest of the phone link.

### 0.21.0
- Forza packs: **Forza Horizon 6, 5 and 4** and **Forza Motorsport**. Every car in each game is in the Library (651, 903, 751 and 680) by make, with its picture, class and PI, value, how to get it, rarity, country and stats. Horizon 6, 5 and 4 have Barn Find checklists, and Horizon 6 a Treasure Car list, each with where the wiki places the car.
- Horizon mods are flagged offline-only, with a warning that your progress syncs to your Xbox profile, so modded credits or cars follow you online.
- Forza Motorsport is online-only (any progression needs a connection), so it gets the Library and overlay but no mods.
- Steam art for newer games: games released since about 2024 keep their Steam art under hashed file names, so covers and banners came up blank. Keystone now asks Steam's store API for the current file when the usual address has nothing. Art Steam really doesn't have is retried after two weeks instead of never.

Car data and pictures come from the [Forza Wiki](https://forza.fandom.com) on Fandom ("how to get it" is the wiki's own wording); executable names from Steam's launch configuration.

### 0.20.0
- Far Cry packs: **Far Cry 3, 4, 5, 6, New Dawn and Primal**. Each has its weapons, vehicles and animals in the Library with pictures (about 860 pages in all), a guide, and Steam art. Mods are flagged single-player/offline only for the games with co-op or multiplayer. Far Cry 5 adds a Prepper Stash checklist.

Far Cry data and pictures come from the [Far Cry Wiki](https://farcry.fandom.com) on Fandom; executable names from Steam's launch configuration.

### 0.19.0
- LEGO packs: **LEGO Star Wars: The Skywalker Saga** (20 codes), **LEGO Star Wars: The Complete Saga** (61) and **LEGO Batman 2: DC Super Heroes** (22). Only codes that two separate guides agree on are included. Codes show on their cards with a Copy button, characters and vehicles have pictures, each game has a guide to entering codes and a "Codes entered" checklist.

LEGO codes were cross-checked between GGRecon, Samurai Gamers and TechRadar (Skywalker Saga), gameplay.tips and GameRevolution (Complete Saga), and GameRevolution and GameFAQs (Batman 2). Executable names come from Steam's launch configuration. Pictures come from Brickipedia and the LEGO Star Wars Wiki on Fandom.

### 0.18.0
- Phasmophobia pack: a **Ghost identifier** (Library, phone and overlay) covering all 30 ghosts, with difficulty-aware evidence, guaranteed evidence, the Mimic's orbs, "worth checking" hints and ruling ghosts out by behaviour; Library pages for every ghost (evidence, strengths, weaknesses), equipment, cursed possessions and maps, with pictures; one-tap incense and hunt-cooldown timers; two guides. Mods are flagged single-player only.
- Packs can add one-tap timers (Overlay tab and phone), entry details and bullet lists to Library pages, and "what is it?" tools.
- Games without commands don't show an empty Commands tab.

Phasmophobia data and pictures come from the [Phasmophobia Wiki](https://phasmophobia.fandom.com) on Fandom. Ghost evidence changes with game updates; `scripts/build-phasmophobia.js` refreshes it.

### 0.17.1
- More Fallout 4 pictures: each item's picture file is read from its wiki infobox, which finds pictures the page-picture lookup missed (450 of 648 items).

### 0.17.0
- Fallout: New Vegas pack: over 1,100 base-game items with Form IDs and pictures, give or drop any of them, and 18 quick commands (god mode, no clip, undetectable, caps, levels, S.P.E.C.I.A.L., skills, Karma, XP, carry weight, Hardcore mode, time and more). A snow globe checklist with locations, three guides, and item pages link to the Fallout Wiki.
- Fixed the word "null" showing on Library pages without a spawn map or credit line.
- Debug and test items are left out of the Fallout 3 list.

### 0.16.0
- Fallout 3 pack: 714 base-game items with Form IDs and pictures (weapons by skill, apparel, aid, ammo, bobbleheads, books, notes and holotapes, misc), give or drop any of them, and 16 quick commands (god mode, no clip, caps, levels, S.P.E.C.I.A.L., skills, Karma, XP, carry weight, time and more). A bobblehead checklist with locations, three guides, and item pages link to the Fallout Wiki.
- Play starts the copy you have installed (another edition, GOG, Epic) before the pack's default Steam app.
- Every bundled pack is now checked by the tests: catalogs, every command, pictures, checklists and guides.

Fallout 3 item data and pictures come from [Nukapedia](https://fallout.fandom.com), the Fallout Wiki on Fandom.

### 0.15.1
- Fallout 4 Library pictures (about two thirds of the 648 items) from Nukapedia on Fandom, using each page's main picture.
- Packs can now take pictures from a wiki page's main image through the wiki's API, for wikis whose file names don't follow the item names.

### 0.15.0
- Library pictures for ARK: creature dossiers and icons, item icons, in the Library and in the Commands pickers (over 99% of entries), downloaded from the ARK Wiki on first view and cached.
- Creature pages show **Where it spawns**, with a tab for each map the creature appears on and a rarity legend.
- Fixed a creature listed as "File:Tidepup (Large).png Tidepup (Large)".

### 0.14.2
- Crosshair overlay with five styles, size, thickness, gap, opacity, colour, outline and nudge, with a live preview; saved per game.
- PC stats panel: CPU, RAM, the time and play time, read from Windows (never from the game).

### 0.14.1
- Timers: countdowns in the overlay with a chime, phone toast and Windows notification when they run out; repeat, pause, and they keep counting across games and restarts.
- Checklists per game, shown in the overlay and on the phone; ARK starts with the Island's artifacts and bosses.
- Phone remote: Timers and Checklist sections, and timer alerts as toasts.

### 0.14.0
- Map for any game, mods or not: an **I'm here** marker you set by clicking the map, and per-pack marker layers you can switch on and off.
- ARK: pick which map you're on; **Find me** (button or Ctrl+Shift+F) reads your position with `ccc` and converts it to the in-game map's lat/lon, with a one-time line-up if it's off. The Island ships with its 10 artifact caves and 3 artifact spots.
- Lat/lon maps show a grid with coordinates until you add a picture; custom map pictures, waypoints and layer choices are kept per map.

### 0.13.1
- The installer build stops if the tag doesn't match `package.json` (v0.13.0's release got the 0.8.0 installer this way), and says so when a release zip was unpacked one folder too deep.

### 0.13.0
- Teleport to any waypoint: a Teleport button on each waypoint, Ctrl+Shift+G for the tracked one, right-click on the overlay map while editing, and a Teleport list on the phone.
- Locked position mods stay locked at the new spot; game packs can tune the landing height and hold time, or teleport by console command.
- The demo game carries on from where you teleport it.

### 0.12.0
- Finds games installed through Steam, Epic, GOG and the Xbox app (Game Pass), marks them in the library with their store, and lists them first.
- Play works for any of those stores, not just Steam.
- Auto-attach: games started outside Keystone are picked up a few seconds after they start. Can be turned off in Settings.
- All / Installed / Running filters on the home screen.

### 0.11.0
- Hotkeys per mod, with rules that keep typing in game from triggering them; each press flashes the result in the overlay.
- Pinned mods: a Pinned tab and a Mods panel in the in-game overlay.
- Mods react to hotkeys by control type: Off/On, step through values, or apply once.

### 0.10.0
- New look modeled on Wand's app: a cover-art game library, game pages with a banner and Play button, pill tabs, mods in glass panels with Off/On toggles, sliders, steps and Apply buttons, and category tabs.
- Accent color picker in Settings (Keystone purple by default), applied to the app, overlay, browser and phone.
- Play starts a game through Steam (or the store its pack names) and connects automatically once it's running.
- Offline-only games: mods stay off, and Keystone doesn't open the game's memory, until you turn them on for that game and accept the warning. Online-only games never get mods.
- When a game closes, its page stays open (map, Library, commands) instead of resetting.
- Game packs can give mods friendly names and controls; the demo pack shows each kind.

### 0.9.0
- Fallout 4 pack: 648 base-game items with Form IDs (weapons, armor, ammo, aid, components and shipments, magazines, misc), give or drop any of them, and 16 quick commands (god mode, no clip, caps, perk points, level, S.P.E.C.I.A.L., carry weight, run speed, time and more). Three guides, and item pages link to their exact Fallout Wiki page.
- Console support for games whose console stays open after Enter (Bethesda games): Keystone opens it once, runs every line, then closes it.
- Dropdown fields in command forms; paste mode and the prefix setting only show where a game supports them.

Fallout 4 item data comes from the community-maintained [Independent Fallout Wiki](https://fallout.wiki).

### 0.8.0
- Library: creature and item pages with IDs and one-click jumps into Commands, Markdown guides (the pack's and your own), personal notes per entry, and search across everything.
- Four ARK guides: admin command cheat sheet, RCON setup, creature IDs and blueprints, and using Keystone with ARK.
- Keystone's browser: a window that floats over the game (Ctrl+Shift+B), remembers its place and your logins, and can be made see-through. Websites run isolated from Keystone.

### 0.7.0
- Windows installer (per-user, Start menu and desktop shortcuts) built with electron-builder, plus a GitHub Actions workflow that builds it on every version tag.
- System tray: closing the window keeps Keystone running; tray menu toggles the overlay and phone control.
- Settings page: keep running in the tray, start with Windows, open the settings and packs folders.
- Only one Keystone runs at a time; launching again brings the window forward.
- Fix: the overlay's map image didn't load for games without mods (like ASA on a BattlEye server). The v0.6 refactor left the map handler requiring a memory session.

### 0.6.0
- Commands: searchable creature and item lists for ARK: Survival Ascended (537 creatures, 1,182 items), spawn tamed or wild at a chosen level, give items to yourself or another player, quick commands, and a free-form command box.
- Sends through the in-game console (simulated keyboard, no memory access) or RCON. Live command preview and history with server replies.
- Admin and RCON passwords encrypted with Windows' per-user key.
- Games now get selected even when their memory can't be read; Mods show as unavailable while Commands, map and waypoints keep working.
- Games with a pack appear in the switcher whether or not they're running.

Creature and item IDs come from the community-maintained [ARK Wiki](https://ark.wiki.gg).

### 0.5.0
- New look modelled on wikily.gg's ARK tools: near-black slate surfaces, card sheen, purple active states, gold highlights, Geist type.
- New layout: collapsible icon sidebar for sections, game switcher in the top bar.
- Overlay, phone app and app icon restyled to match.

### 0.4.0
- In-game overlay: minimap with live position and facing, waypoints, stats readout, info cards and notes.
- Two-click map calibration, or type the map edges.
- Hotkeys to show/hide, edit the layout, and drop waypoints.
- Game packs: per-game table, map, position mods, waypoints and info cards. The demo game is now a pack.
- Fix: the main window kept rendering while the overlay covers it.

### 0.3.0
- Phone remote: pair by QR code, lock/set mods and apply profiles from your phone, add it to your home screen.
- Pairing code with constant-time check, rate limiting on bad codes, and one-tap reset.
- App icon.

### 0.2.0
- Saved profiles per game: save, save as new, rename, delete, unsaved-changes indicator.
- Active profile auto-applies when the game is attached (can be turned off).
- Loaded cheat tables are remembered per game and reloaded on attach.

### 0.1.0
- Attach to running games, load Cheat Engine tables, lock and set values.
- Built-in demo game.
