# Using Keystone with ARK

ARK on a BattlEye server doesn't let other programs read its memory, so Keystone's memory mods don't apply there. Everything else does.

## What works on your server

- **Commands**: spawn creatures, give items and run admin commands, through the game console or RCON.
- **Phone remote**: pick commands from your phone while you play.
- **Overlay**: a minimap with your waypoints, info cards and notes over the game. Run ARK in borderless or windowed mode so the overlay can show.
- **Browser**: Ctrl+Shift+B opens Keystone's browser on top of the game, so you can look things up without alt-tabbing.

## The map without live position

Without memory access Keystone doesn't know where you are, so the minimap shows your waypoints rather than following you.

1. Take a screenshot of ARK's world map and choose it in **Overlay → Map**.
2. Type the map's edges under **Type the map edges instead**. The easiest way is to drop two waypoints at known coordinates and adjust until they land on the right spots.
3. Add waypoints for your bases, caves and taming spots by typing their coordinates in the **Waypoints** list.

## Single-player

In single-player ARK without BattlEye, memory mods can work with a Cheat Engine table made for your game version. Set the command prefix to `cheat` in **Commands → Settings**.
