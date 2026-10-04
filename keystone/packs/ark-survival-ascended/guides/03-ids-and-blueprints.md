# Creature IDs and item blueprints

Admin commands need ARK's internal names, not the names you see in game. Every page in this Library shows them, and the command center fills them in for you.

## Creature IDs

A creature ID looks like `Rex_Character_BP_C`. It's what `GMSummon` and `Summon` expect, in quotes.

Variants have their own IDs. An Alpha Rex, a Tek Rex and a Rex Ghost are all separate creatures, and so are map-specific versions like X- and R- creatures. Search the Library for the base name to see every variant together.

## Item blueprints

An item's blueprint path looks like `/Game/PrimalEarth/CoreBlueprints/Resources/PrimalItemResource_MetalIngot.PrimalItemResource_MetalIngot`. `GiveItem` takes it wrapped as `"Blueprint'<path>'"`.

The shorter `GFI` command searches for a part of that path, which is quicker to type but can grab the wrong item when two names overlap. That's why Keystone always sends the full path.

## When a spawn does nothing

- The creature or item may belong to a map or DLC your server doesn't run. The lists include creatures from every map, so not all of them exist everywhere.
- You may not be logged in as admin yet. Press **Log in as admin** in Commands.
- The command prefix may be wrong. On a server it's `admincheat`; in single-player it's `cheat`.

The IDs in this pack come from the community-maintained ARK Wiki.
