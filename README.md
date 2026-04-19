# File Title Sync

Syncs an Obsidian note title across:

- the filename
- the first Markdown H1
- the `title` frontmatter property

The sync runs when the active Markdown editor changes in Obsidian. Files modified outside Obsidian, or files that are not the currently active note, are not synced or renamed.

Filenames are lowercased and converted to web URL-safe slugs by replacing special characters with `-`. The generated filename is capped at 180 percent-encoded URL characters, so non-Latin titles are truncated before copied Obsidian URLs become too long.

When frontmatter exists, the plugin keeps one blank line between the closing frontmatter marker and the note body or H1.

Run **File Title Sync: Resync all file titles** from Obsidian's command palette to reprocess every Markdown file that matches the folder and tag settings.

## Settings

- **Enable title sync**: turn all heading, frontmatter, and filename syncing on or off.
- **Source of truth**: choose which title source wins when values mismatch.
  - First H1 heading
  - Title frontmatter
  - Filename
- **Only folders**: one folder path per line. When set, only notes inside matching folders are synced.
- **Excluded folders**: one folder path per line. Every note inside a matching folder is skipped.
- **Excluded tags**: one tag per line, with or without `#`. Notes with matching frontmatter or inline tags are skipped.

If the selected source of truth is missing or blank, the plugin falls back to the other title sources in this order:

1. First H1 heading
2. Title frontmatter
3. Filename

## Development

```bash
npm install
npm run build
```
