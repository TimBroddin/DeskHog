# Categories in the plugin directory

Approved by Tim on 2026-11-23.

**Why:** 56 plugins in one alphabetical list is too much to look through.

**What:** every plugin of a directory may be in one category. Get plugins has a
row of filter buttons, Add a card groups what the directory has, the README has
a section per category, and `tools/deskhog directory` and the MCP tool
`directory` name the category. A directory without categories looks as before,
and firmware that does not know them ignores the new fields.

**Where they are kept:** `plugins/categories.json`, category name to plugin
names, in the order to show them. `tools/deskhog index` writes `categories` (the
names in order) and each plugin's `category` into `index.json`. With the file
there, a plugin in no category or in two, or a name that is no plugin, is an
error, so CI finds it.

**Approaches**
- A file next to the plugins (picked): no plugin file changes.
- `category` in each plugin's table: tidier for authors, but every plugin's hash
  changes, so every installed plugin shows an update.

**Not now:** download counts. Nothing counts installs, and the numbers would be
too low to help. jsDelivr's per-file statistics would be the cheap way.
