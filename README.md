# File Title Sync

Syncs an Obsidian note title across:

- the filename
- the first Markdown H1
- the `title` frontmatter property
- the `filename` frontmatter property for one-way filename renames

The sync runs when the active Markdown file is modified in Obsidian. Files modified outside Obsidian, or files that are not the currently active note, are not synced or renamed.

When a note has `filename` frontmatter, that metadata is used only for the file rename and takes priority over the synced title. The value still goes through the matching rename rule's slug or sanitize strategy before the file is renamed. The plugin does not write back to `filename`.

Filenames are renamed by ordered folder rules. The first rule that matches a note decides how the filename is generated:

- `Slug`: lowercase, replace special characters with `-`, and truncate for safe URL length.
- `Sanitize`: keep case, but replace spaces and special characters such as `(` and `)` with `-`.

The generated filename is capped at 180 percent-encoded URL characters, so non-Latin titles are truncated before copied Obsidian URLs become too long.

When frontmatter exists, the plugin keeps one blank line between the closing frontmatter marker and the note body or H1.

Run **File Title Sync: Resync all file titles** from Obsidian's command palette to reprocess every Markdown file that matches the tag and rename rule settings.

## Settings

- **Enable title sync**: turn all heading, frontmatter, and filename syncing on or off.
- **Source of truth**: choose which title source wins when values mismatch.
  - First H1 heading
  - Title frontmatter
  - Filename
- **Metadata fields**: `title` is synced with the H1/title source, while `filename` is one-way metadata for the actual filename.
- **Excluded tags**: one tag per line, with or without `#`. Notes with matching frontmatter or inline tags are skipped.
- **Excluded folders**: one vault-relative folder path per line. Notes inside matching folders are skipped before title, metadata, or filename sync runs.
- **Rename rules**: ordered folder items with their own strategy, enabled state, excluded subfolders, included files, and excluded files.

This is a breaking change from the previous settings model. Legacy rename settings are not migrated.

If the selected source of truth is missing or blank, the plugin falls back to the other title sources in this order:

1. First H1 heading
2. Title frontmatter
3. Filename

## Development

```bash
npm install
npm run build
```
