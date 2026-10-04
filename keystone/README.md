# Keystone

A mod control panel for single-player PC games. Load a Cheat Engine table for a game and its values become switches you can lock or set from a clean desktop app.

**Mods and online games:** memory mods are for offline and single-player play. Keystone reads and writes another program's memory the same way Cheat Engine does, and it never hides from, bypasses or works around anti-cheat.

- Games with an offline or solo mode are flagged **Offline only**. Their mods stay off until you turn on **Use mods in this game** and accept the warning, and Keystone doesn't touch the game's memory at all while they're off.
- Games with no offline mode never get mods. Their Library, commands (where the game has them), map and overlay still work, because none of those touch the game.

## Install

**The easy way: the installer.** Run `Keystone Setup <version>.exe`. It installs for your Windows account only (no administrator needed) and adds Keystone to the Start menu and desktop.

The installer isn't code-signed, so the first time Windows shows *"Windows protected your PC"*. Click **More info**, then **Run anyway**. Signing needs a paid certificate; this is the same prompt every unsigned app gets.

**Updating:** run the newer installer. It replaces the old version and keeps all your settings, profiles, waypoints and command setup (they live in `%APPDATA%\Keystone`).

**Uninstalling:** Windows Settings → Apps → Keystone. Your settings folder stays behind in case you reinstall; delete it by hand if you want a clean slate.

### Getting the installer

- **From GitHub (recommended):** push a version tag and GitHub builds it on a Windows machine:
  ```bash
  git tag v0.7.0
  git push origin v0.7.0
  ```
  When the **Build installer** action finishes, the installer is on the repo's **Releases** page.
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

### Library

Each game's knowledge in one place. Open **Library** in the sidebar.

- **Browse** creature and item pages: category, map, the IDs admin commands need (with Copy buttons), and buttons that jump straight to Commands with that creature or item picked.
- **Guides** written for the game, plus your own: drop Markdown (`.md`) files in your guides folder (**Library → All guides → Open my guides folder**) and they show up next to the pack's guides.
- **My notes** on any creature or item, saved per game.
- **Search** covers everything at once.

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

On the phone, flip a switch to lock a mod, tap a mod's name to set or lock a specific value, and pick a profile at the top to apply it. Everything stays in sync with the desktop window.

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
| Ctrl+Shift+E | Edit layout: drag panels, click the minimap to add a waypoint, right-click it to teleport there, scroll to zoom |
| Ctrl+Shift+W | Drop a waypoint where you're standing |
| Ctrl+Shift+G | Teleport to the tracked waypoint |

Waypoints can be renamed, moved, tracked (distance and direction show under the minimap), teleported to and deleted in the Overlay tab. The phone remote lists them too, with a **Go** button each.

**Teleporting** writes your position through the game's position mods, so it needs mods connected and the X and Y position mods set in the Overlay tab (game packs set them for you). It holds the new spot for a moment so the game doesn't pull you back. If the waypoint has no height saved, you keep your current height, so on hilly maps you may land inside a slope; walk or jump out. Games with a teleport console command can use that instead, and then it works without mods. Offline-only games follow the same rule as other mods: off until you turn mods on for that game.

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
| Auto Assembler scripts | Listed, not runnable (they need Cheat Engine's assembler) |
| Strings, byte arrays, custom types | Listed, not supported yet |
| Addresses using symbols a script defines (e.g. `pPlayer`) | Listed, not supported |

Many popular tables are mostly scripts. Tables built from pointer scans (plain addresses with offsets) work best.

## Project layout

```
src/main/            Electron main process
  main.js            windows, IPC, single instance, start with Windows
  art.js             game cover and banner art (Steam CDN, cached)
  installed.js       finds installed games (Steam, Epic, GOG, Xbox app)
  hotkeys.js         per-mod hotkey rules and registration
  tray.js            system tray icon and menu
  library.js         Library: catalog pages, Markdown guides, notes, search
  browser-window.js  Keystone's browser window (Ctrl+Shift+B)
  controller.js      app actions, shared by every UI
  store.js           per-game settings and profiles on disk
  settings.js        app-wide settings (phone remote, overlay)
  packs.js           game packs
  overlay-model.js   overlay data: position, map, waypoints, stats
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
    demo-game.js     fake game used by the demo and tests
src/renderer/        desktop UI
src/remote-web/      phone web app (served to the phone by remote/server.js)
src/overlay/         overlay page (minimap, stats, info)
src/browser/         the browser window's toolbar page
assets/              app icons
src/shared/          shared styles, accent themes, Geist fonts (OFL), map math
packs/demo/          the demo game's pack: table, map, waypoints, info
packs/ark-survival-ascended/  ASA pack: commands, creature and item IDs, guides
packs/fallout-4/     Fallout 4 pack: console commands, 648 base-game items, guides
test/                node:test suite
scripts/capture.js   dev helper: launch, run a snippet, save a screenshot
.github/workflows/   builds the Windows installer when a version tag is pushed
```

## Changelog

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
