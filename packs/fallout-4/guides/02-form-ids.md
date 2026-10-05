# Form IDs and DLC items

Fallout 4 identifies every item by a Form ID: eight characters of hexadecimal, like `00023736` for a Stimpak. `player.additem` and `player.placeatme` need it.

## The first two characters

The first two characters say which game file the item comes from, by its position in your load order.

- **00** is the base game, Fallout4.esm. These IDs are the same for everyone, which is why Keystone's item list covers the base game.
- **DLC items** start with the DLC's position instead. A Far Harbor item that the wiki writes as `xx00CC05` might be `0300CC05` on one PC and `0700CC05` on another, depending on what's installed.

## Finding a DLC item's ID

1. Open the console with **~**.
2. Type `help "<part of the name>" 4`, like `help "harpoon" 4`.
3. The console lists matching items with their full Form IDs, with the right first two characters for your game.
4. Use that ID in **Commands → Type a command**, like `player.additem 0300CC05 1`.

With no mods installed, the official DLC usually load in this order: Automatron, Wasteland Workshop, Far Harbor, Contraptions Workshop, Vault-Tec Workshop, Nuka-World. Mod managers and Creation Club content can change that, so `help` is the reliable way.

## Unique weapons

Adding a named weapon by ID gives you the weapon, but not always the legendary effect it has when you find it in the world. That's how the game stores them, not a Keystone limit.
