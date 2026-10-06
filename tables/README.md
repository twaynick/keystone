# Bundled cheat tables

Tables in this folder ship in the installer and load by themselves when their game starts.

    tables/<game>/<any name>.ct
    tables/<game>/credits.json      (optional)

`<game>` is the game pack's folder name under `packs/` (for example `fallout-4`,
`ark-survival-ascended`, `fallout-shelter`). For a game without a pack, use its exe
name without `.exe`, in lowercase.

`credits.json` names who made each table. It shows on the Mods tab:

```json
{
  "Fallout4.CT": {
    "author": "Table author's name",
    "url": "https://link-to-their-post-or-page",
    "note": "Optional note"
  }
}
```

Tables for just one PC go in `%APPDATA%\Keystone\tables\<game>\` instead (Mods tab,
**Tables folder**). Those never end up in a build.

## The Tables tab (`store.json`)

`store.json` lists the community tables shown on the **Tables** tab. Keystone only links to them: each one is
downloaded from its creator's page by whoever installs it.

```json
{ "id": "fo4-main", "pack": "fallout-4", "title": "Fallout 4", "url": "https://fearlessrevolution.com/viewtopic.php?t=210" }
```

- `id`: unique and never reused (installs and update checks are remembered by it).
- `pack`: the game pack's folder name. Games with `"memory": false` get no tables.
- `url`: the table's topic page. Downloads started from that topic install as this table.
- Optional: `author` (otherwise read from the page), `note` (shown on the card).
