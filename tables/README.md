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
