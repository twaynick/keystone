# Console command cheat sheet

Fallout 4's console opens with the **~** key (top-left, under Esc). Keystone opens it, types the command, presses Enter and closes it for you. Commands work in any case: `tgm`, `TGM` and `tGm` are the same.

The console is **turned off in Survival difficulty**. Commands only work on the other difficulties.

## You

- `tgm` toggles god mode: no damage, unlimited ammo and Action Points, no carry limit.
- `tim` toggles immortal mode: you still take damage, but your health never runs out.
- `tcl` toggles no clip, so you can walk through walls and fly.
- `player.setlevel <level>` sets your level. It can't level you down.
- `CGF "Game.AddPerkPoints" <points>` gives you perk points to spend in the perk chart.
- `player.setav <stat> <value>` sets a S.P.E.C.I.A.L. stat, like `player.setav strength 10`. Perks that need a higher stat unlock right away.
- `player.modav carryweight <amount>` adds to your carry weight.
- `player.setav speedmult <percent>` sets your run speed; 100 is normal.

## Items

- `player.additem <Form ID> <quantity>` adds an item to your inventory, like `player.additem 0000000F 500` for 500 caps.
- `player.placeatme <Form ID> <quantity>` drops it on the ground next to you.

Every item page in the Library shows its Form ID.

## World

- `tmm 1` reveals every location on the map. It can't be undone in that save.
- `set gamehour to <hour>` sets the time, from 0 to 23.
- `set timescale to <number>` changes how fast time passes. The default is 20.
- `killall` kills every non-essential character nearby, friendly ones included.
- `tfc` toggles a free camera; `tm` hides and shows the HUD.
- `csb` clears blood and other effects from the screen.

## Clicking on things

With the console open, clicking an object or character selects it, and its ID shows at the top. Commands typed without `player.` then act on it: `unlock` opens a selected door or safe, and `resurrect` brings a selected character back. Keystone doesn't do this part for you, because it needs a click in the game.
