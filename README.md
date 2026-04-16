# File Title Sync

Syncs an Obsidian note title across:

- the filename
- the first Markdown H1
- the `title` frontmatter property

The sync runs when a Markdown file is modified. The first H1 is the source of truth when present, then `title` frontmatter, then the current filename.

Filenames are lowercased and converted to web URL-safe slugs by replacing special characters with `-`.

When frontmatter exists, the plugin keeps one blank line between the closing frontmatter marker and the note body or H1.

## Settings

- **Source of truth**: choose which title source wins when values mismatch.
  - First H1 heading
  - Title frontmatter
  - Filename
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
