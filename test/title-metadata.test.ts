import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildFileBaseName,
  getFolderNoteRenameTargetPath,
  getTitleFileBaseName,
  isPathInExcludedFolders,
  isFolderNote,
  readFrontmatterTitle,
  selectCanonicalTitle,
  selectRenameTitle,
  splitLines,
} from "../main";

describe("metadata filename source", () => {
  it("uses filename frontmatter before title and sanitizes it for renames", () => {
    const lines = splitLines(`---
filename: "My Draft (v2)!"
title: Existing Title
---

# Heading Title
`);

    const renameTitle = selectRenameTitle({
      lines,
      canonicalTitle: "Existing Title",
    });

    assert.equal(renameTitle, "My Draft (v2)!");
    assert.equal(buildFileBaseName(renameTitle, "sanitize"), "My-Draft-v2");
  });

  it("falls back to title frontmatter when filename frontmatter is missing", () => {
    const lines = splitLines(`---
title: Existing Title
---

# Heading Title
`);

    assert.equal(readFrontmatterTitle(lines), "Existing Title");
    assert.equal(
      selectRenameTitle({
        lines,
        canonicalTitle: "Existing Title",
      }),
      "Existing Title",
    );
  });

  it("ignores blank filename frontmatter", () => {
    const lines = splitLines(`---
filename: "   "
title: Existing Title
---

# Heading Title
`);

    assert.equal(
      selectRenameTitle({
        lines,
        canonicalTitle: "Existing Title",
      }),
      "Existing Title",
    );
  });
});

describe("global excluded folders", () => {
  it("matches files inside normalized excluded folders", () => {
    assert.equal(
      isPathInExcludedFolders("Projects/Drafts/Note.md", [
        "/Projects/Drafts/",
      ]),
      true,
    );
    assert.equal(
      isPathInExcludedFolders("Projects/Published/Note.md", [
        "/Projects/Drafts/",
      ]),
      false,
    );
  });
});

describe("folder notes", () => {
  it("detects index.md files inside a named folder as folder notes", () => {
    assert.equal(
      isFolderNote({
        basename: "index",
        parent: { name: "Project Alpha", path: "Projects/Project Alpha" },
      }),
      true,
    );
    assert.equal(
      isFolderNote({
        basename: "Project Alpha",
        parent: { name: "Projects", path: "Projects" },
      }),
      false,
    );
  });

  it("uses the parent folder name as the filename title source for folder notes", () => {
    const folderNote = {
      basename: "index",
      parent: { name: "Project Alpha", path: "Projects/Project Alpha" },
    };

    assert.equal(getTitleFileBaseName(folderNote), "Project Alpha");
    assert.equal(
      selectCanonicalTitle({
        primarySource: "filename",
        lines: splitLines(""),
        fileBasename: getTitleFileBaseName(folderNote),
      }),
      "Project Alpha",
    );
  });

  it("builds a parent folder rename target for matching folder notes", () => {
    const folderNote = {
      basename: "index",
      parent: {
        name: "Project Alpha",
        path: "Projects/Project Alpha",
        parent: { path: "Projects" },
      },
    };

    assert.equal(
      getFolderNoteRenameTargetPath(folderNote, "project-beta"),
      "Projects/project-beta",
    );
    assert.equal(
      getFolderNoteRenameTargetPath(folderNote, "project-beta", 2),
      "Projects/project-beta-3",
    );
  });
});
