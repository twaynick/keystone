# Console command cheat sheet

Fallout 3's console opens with the **~** key (top-left, under Esc). Keystone opens it, types the command, presses Enter and closes it for you. Commands work in any case: `tgm`, `TGM` and `tGm` are the same.

## You

- `tgm` toggles god mode: no damage, no radiation, unlimited ammo and Action Points, no carry limit.
- `tcl` toggles no clip, so you can walk through walls and fly.
- `player.advlevel` takes you up one level, with the level-up screen.
- `player.setlevel <level>` sets your level. The cap is 20, or 30 with Broken Steel.
- `player.setav <stat> <value>` sets a S.P.E.C.I.A.L. stat, like `player.setav strength 10`.
- `player.setav <skill> <value>` sets a skill, like `player.setav smallguns 100`. Skill names have no spaces: `bigguns`, `energyweapons`, `meleeweapons`.
- `player.rewardKarma <amount>` changes your Karma; a negative number lowers it.
- `player.rewardXP <amount>` gives you experience points.
- `player.modav carryweight <amount>` adds to your carry weight.
- `showracemenu` reopens the character editor. Changing race can remove perks.

## Items

- `player.additem <Form ID> <quantity>` adds an item to your inventory, like `player.additem 0000000F 500` for 500 caps.
- `player.placeatme <Form ID> <quantity>` drops it on the ground next to you.

Every item page in the Library shows its Form ID.

## World

- `tmm 1` reveals every location on the map and makes them fast-travel points. It can't be undone in that save.
- `set gamehour to <hour>` sets the time, from 0 to 23.
- `killall` kills every non-essential character nearby. Quest characters you can't see may be among them.
- `tfc` toggles a free camera; `tm` hides the HUD, for screenshots.

## Targeting

Some commands act on whatever you click while the console is open: open the console, click a character or object (its ID shows at the top), then type the command.

- `unlock` unlocks the door, safe or terminal you clicked.
- `kill` kills the character you clicked; `resurrect` brings them back.

Keystone's commands close the console after each one, so for targeted commands, use **Type a command** with the console already open and the target clicked, or type them yourself.
