# Form IDs and DLC items

Fallout 3 identifies every item by a Form ID: eight characters of hexadecimal, like `00015169` for a Stimpak. `player.additem` and `player.placeatme` need it.

## The first two characters

The first two characters say which game file the item comes from, by its position in your load order.

- **00** is the base game, Fallout3.esm. These IDs are the same for everyone, which is why Keystone's item list covers the base game.
- **DLC items** start with the DLC's position instead. The wiki writes them as `xx` followed by six characters, like `xx00a3f1`.

## Working out a DLC item's ID

With the Game of the Year Edition and no mods, the DLC usually load in this order:

| Position | DLC | First two characters |
| --- | --- | --- |
| 1 | Operation: Anchorage | `01` |
| 2 | The Pitt | `02` |
| 3 | Broken Steel | `03` |
| 4 | Point Lookout | `04` |
| 5 | Mothership Zeta | `05` |

So a Broken Steel item the wiki lists as `xx00a3f1` is usually `0300a3f1`. With mods, check the order in the Fallout Launcher's **Data Files** list or your mod manager: count down from Fallout3.esm (00), and the DLC's position is its number, written as two hexadecimal digits.

Then use it in **Commands → Type a command**, like `player.additem 0300a3f1 1`.

## Unique weapons and armor

Many named weapons and outfits have their own Form ID, listed on their wiki page and in Keystone's item list where they're in the base game.
