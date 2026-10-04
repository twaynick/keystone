# Admin command cheat sheet

The commands Keystone's command center uses, and a few more worth knowing. On a server, type them in the console (Tab by default) after logging in as admin.

## Logging in

- `EnableCheats <password>` logs you in as admin with the server's admin password. Do this once per session. Keystone's **Log in as admin** button types it for you.
- On a server, put `admincheat` in front of every command, like `admincheat God`. In single-player, use `cheat` instead.

## Creatures

- `GMSummon "<creature ID>" <level>` spawns a tamed creature next to you. The level is its level after taming.
- `Summon "<creature ID>"` spawns a wild creature next to you.
- `ForceTame` instantly tames the creature you're looking at.
- `DestroyWildDinos` removes every wild creature on the map. They respawn over time.

Creature IDs look like `Rex_Character_BP_C`. Every creature page in the Library shows its ID.

## Items

- `GiveItem "Blueprint'<blueprint path>'" <quantity> <quality> <0 or 1>` puts an item in your inventory. The last number is 1 for a blueprint, 0 for the item itself.
- `GFI <short name> <quantity> <quality> <0 or 1>` does the same with part of the item's name, like `GFI MetalIngot 100 0 0`. It's quicker to type, but it can match the wrong item when names overlap, so Keystone always uses the full blueprint path.
- `GiveItemToPlayer <player ID> "Blueprint'<path>'" <quantity> <quality> <0 or 1>` sends an item to someone else. It also works over RCON.

## You

- `God` toggles taking no damage.
- `InfiniteStats` toggles unlimited health, stamina, food, water and carry weight.
- `Fly` lets you fly; `Walk` turns flying (and `Ghost`) off.
- `Ghost` lets you pass through walls and terrain.
- `LeaveMeAlone` combines god mode and infinite stats, and creatures ignore you.
- `AddExperience <amount> 0 0` gives you experience.

## Server

- `SaveWorld` saves the world right now.
- `SetTimeOfDay <hh:mm>` changes the time, in 24-hour format.
- `ListPlayers` lists who's online.
- `ServerChat <message>` sends a message to everyone.

All the server commands also work over RCON, without being in the game.
