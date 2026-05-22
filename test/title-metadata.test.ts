import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildFileBaseName,
  isPathInExcludedFolders,
  readFrontmatterTitle,
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
