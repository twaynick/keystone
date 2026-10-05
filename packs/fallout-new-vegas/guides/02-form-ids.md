# Form IDs and DLC items

New Vegas identifies every item by a Form ID: eight characters of hexadecimal, like `00015169` for a Stimpak. `player.additem` and `player.placeatme` need it.

## The first two characters

The first two characters say which game file the item comes from, by its position in your load order.

- **00** is the base game, FalloutNV.esm. These IDs are the same for everyone, which is why Keystone's item list covers the base game.
- **DLC items** start with the DLC's position instead. The wiki writes them as `xx` followed by six characters.

## Working out a DLC item's ID

With the Ultimate Edition and no mods, the DLC usually load in this order:

| Position | DLC | First two characters |
| --- | --- | --- |
| 1 | Dead Money | `01` |
| 2 | Honest Hearts | `02` |
| 3 | Old World Blues | `03` |
| 4 | Lonesome Road | `04` |
| 5 | Gun Runners' Arsenal | `05` |
| 6–9 | Courier's Stash packs (Caravan, Classic, Mercenary, Tribal) | `06`–`09` |

So a Lonesome Road item the wiki lists as `xx0008e7` is usually `040008e7`. With mods, check the order in the launcher's **Data Files** list or your mod manager: count down from FalloutNV.esm (00), and the DLC's position is its number, written as two hexadecimal digits.

Then use it in **Commands → Type a command**, like `player.additem 040008e7 1`.
