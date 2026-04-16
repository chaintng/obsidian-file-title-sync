import {
  App,
  normalizePath,
  Plugin,
  PluginSettingTab,
  Setting,
  TAbstractFile,
  TFile,
} from "obsidian";

const URL_UNSAFE_FILENAME_CHARS = /[^\p{Letter}\p{Mark}\p{Number}]+/gu;
const MULTIPLE_DASHES = /-{2,}/g;
const EDGE_DASHES = /^-+|-+$/g;
const H1_PATTERN = /^#(?!#)\s+(.+?)\s*#*\s*$/;
const INLINE_TAG_PATTERN = /(^|\s)#([A-Za-z0-9_/-]+)/g;
const EDITOR_CHANGE_SYNC_DELAY_MS = 1_000;

type TitleSource = "heading" | "frontmatter" | "filename";

interface FileTitleSyncSettings {
  enabled: boolean;
  titleSource: TitleSource;
  onlyFolders: string[];
  excludedFolders: string[];
  excludedTags: string[];
}

const DEFAULT_SETTINGS: FileTitleSyncSettings = {
  enabled: true,
  titleSource: "heading",
  onlyFolders: [],
  excludedFolders: [],
  excludedTags: [],
};

const TITLE_SOURCE_LABELS: Record<TitleSource, string> = {
  heading: "First H1 heading",
  frontmatter: "Title frontmatter",
  filename: "Filename",
};

interface FrontmatterRange {
  startLine: number;
  endLine: number;
}

interface HeadingMatch {
  lineIndex: number;
  title: string;
}

export default class FileTitleSyncPlugin extends Plugin {
  private readonly syncingPaths = new Set<string>();
  private readonly pendingSyncTimers = new Map<string, number>();
  settings: FileTitleSyncSettings = DEFAULT_SETTINGS;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new FileTitleSyncSettingTab(this.app, this));

    this.app.workspace.onLayoutReady(() => {
      this.registerEvent(
        this.app.workspace.on("editor-change", (_editor, info) => {
          const file = info.file;

          if (file !== null) {
            this.scheduleSyncFile(file);
          }
        }),
      );
    });
  }

  onunload(): void {
    this.pendingSyncTimers.forEach((timerId) => {
      window.clearTimeout(timerId);
    });
    this.pendingSyncTimers.clear();
  }

  async loadSettings(): Promise<void> {
    const storedSettings =
      (await this.loadData()) as Partial<FileTitleSyncSettings> | null;
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...storedSettings,
      onlyFolders: cleanList(
        storedSettings?.onlyFolders ?? DEFAULT_SETTINGS.onlyFolders,
      ),
      excludedFolders: cleanList(
        storedSettings?.excludedFolders ?? DEFAULT_SETTINGS.excludedFolders,
      ),
      excludedTags: cleanList(
        storedSettings?.excludedTags ?? DEFAULT_SETTINGS.excludedTags,
      ).map(normalizeTag),
    };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  private isMarkdownFile(file: TAbstractFile): file is TFile {
    return file instanceof TFile && file.extension === "md";
  }

  private isActiveFile(file: TFile): boolean {
    const activeFile = this.app.workspace.getActiveFile();
    return (
      activeFile !== null &&
      normalizePath(activeFile.path) === normalizePath(file.path)
    );
  }

  private scheduleSyncFile(file: TFile): void {
    if (
      !this.settings.enabled ||
      !this.isMarkdownFile(file) ||
      !this.isActiveFile(file)
    ) {
      return;
    }

    const existingTimerId = this.pendingSyncTimers.get(file.path);
    if (existingTimerId !== undefined) {
      window.clearTimeout(existingTimerId);
    }

    const timerId = window.setTimeout(() => {
      this.pendingSyncTimers.delete(file.path);
      void this.syncFile(file);
    }, EDITOR_CHANGE_SYNC_DELAY_MS);

    this.pendingSyncTimers.set(file.path, timerId);
  }

  private async syncFile(file: TFile): Promise<void> {
    const originalPath = file.path;

    if (
      !this.settings.enabled ||
      !this.isActiveFile(file) ||
      this.syncingPaths.has(originalPath) ||
      !this.isAllowedFolder(file) ||
      this.isExcludedFolder(file)
    ) {
      return;
    }

    this.syncingPaths.add(originalPath);

    try {
      const content = await this.app.vault.cachedRead(file);
      if (this.hasExcludedTag(content)) {
        return;
      }

      const lines = splitLines(content);
      const title = this.getCanonicalTitle(content, file);
      const nextContent = this.withSyncedHeading(content, title);
      const frontmatterTitle = readFrontmatterTitle(lines);

      if (nextContent !== content) {
        await this.app.vault.process(file, () => nextContent);
      }

      if (frontmatterTitle !== title) {
        await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
          frontmatter.title = title;
        });
      }

      await this.ensureFrontmatterSpacing(file);
      await this.renameFileIfNeeded(file, title);
    } finally {
      this.syncingPaths.delete(originalPath);
    }
  }

  private getCanonicalTitle(content: string, file: TFile): string {
    const lines = splitLines(content);
    const titleCandidates: Record<TitleSource, string | null> = {
      heading: findFirstH1(lines)?.title ?? null,
      frontmatter: readFrontmatterTitle(lines),
      filename: file.basename,
    };

    for (const source of getTitleSourceOrder(this.settings.titleSource)) {
      const candidate = titleCandidates[source];

      if (candidate !== null && candidate.trim().length > 0) {
        return normalizeTitle(candidate);
      }
    }

    return "Untitled";
  }

  private withSyncedHeading(content: string, title: string): string {
    const lineEnding = content.includes("\r\n") ? "\r\n" : "\n";
    const lines = splitLines(content);
    const heading = findFirstH1(lines);
    const syncedHeading = `# ${title}`;

    if (heading !== null) {
      lines[heading.lineIndex] = syncedHeading;
      ensureBlankLineAfterFrontmatter(lines);
      return lines.join(lineEnding);
    }

    const frontmatterRange = findFrontmatterRange(lines);
    ensureBlankLineAfterFrontmatter(lines);

    const insertIndex =
      frontmatterRange === null ? 0 : frontmatterRange.endLine + 2;
    lines.splice(insertIndex, 0, syncedHeading);
    return lines.join(lineEnding);
  }

  private async ensureFrontmatterSpacing(file: TFile): Promise<void> {
    const content = await this.app.vault.cachedRead(file);
    const nextContent = withBlankLineAfterFrontmatter(content);

    if (nextContent === content) {
      return;
    }

    await this.app.vault.process(file, withBlankLineAfterFrontmatter);
  }

  private async renameFileIfNeeded(file: TFile, title: string): Promise<void> {
    if (!this.isActiveFile(file)) {
      return;
    }

    const safeBaseName = toSafeFileBaseName(title);
    const targetPath = await this.getAvailablePath(file, safeBaseName);

    if (targetPath === file.path) {
      return;
    }

    await this.app.fileManager.renameFile(file, targetPath);
  }

  private async getAvailablePath(
    file: TFile,
    safeBaseName: string,
  ): Promise<string> {
    const folderPath = file.parent?.path ?? "";
    const folderPrefix =
      folderPath === "/" || folderPath === "" ? "" : `${folderPath}/`;
    const currentPath = normalizePath(file.path);
    let suffix = 0;

    while (true) {
      const candidateName =
        suffix === 0 ? safeBaseName : `${safeBaseName}-${suffix + 1}`;
      const candidatePath = normalizePath(
        `${folderPrefix}${candidateName}.${file.extension}`,
      );
      const existingFile = this.app.vault.getAbstractFileByPath(candidatePath);

      if (candidatePath === currentPath || existingFile === null) {
        return candidatePath;
      }

      suffix += 1;
    }
  }

  private isExcludedFolder(file: TFile): boolean {
    return this.settings.excludedFolders.some((folder) =>
      isPathInFolder(file.path, folder),
    );
  }

  private isAllowedFolder(file: TFile): boolean {
    if (this.settings.onlyFolders.length === 0) {
      return true;
    }

    return this.settings.onlyFolders.some((folder) =>
      isPathInFolder(file.path, folder),
    );
  }

  private hasExcludedTag(content: string): boolean {
    if (this.settings.excludedTags.length === 0) {
      return false;
    }

    const fileTags = readTags(content).map(normalizeTag);
    return this.settings.excludedTags.some((excludedTag) =>
      fileTags.includes(excludedTag),
    );
  }
}

class FileTitleSyncSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: FileTitleSyncPlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Enable title sync")
      .setDesc("When disabled, the plugin will not sync headings, frontmatter, or filenames.")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.enabled)
          .onChange(async (value) => {
            this.plugin.settings.enabled = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Source of truth")
      .setDesc(
        "When titles mismatch, this value wins. If it is missing, the plugin falls back to the other title locations.",
      )
      .addDropdown((dropdown) => {
        Object.entries(TITLE_SOURCE_LABELS).forEach(([value, label]) => {
          dropdown.addOption(value, label);
        });

        dropdown
          .setValue(this.plugin.settings.titleSource)
          .onChange(async (value) => {
            this.plugin.settings.titleSource = toTitleSource(value);
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Only folders")
      .setDesc(
        "One folder path per line. When set, only notes inside these folders are synced.",
      )
      .addTextArea((text) => {
        text
          .setPlaceholder("Writing\nPublished")
          .setValue(this.plugin.settings.onlyFolders.join("\n"))
          .onChange(async (value) => {
            this.plugin.settings.onlyFolders = cleanList(value.split("\n"));
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Excluded folders")
      .setDesc(
        "One folder path per line. A folder excludes every note inside it.",
      )
      .addTextArea((text) => {
        text
          .setPlaceholder("Templates\nArchive/Private")
          .setValue(this.plugin.settings.excludedFolders.join("\n"))
          .onChange(async (value) => {
            this.plugin.settings.excludedFolders = cleanList(value.split("\n"));
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Excluded tags")
      .setDesc(
        "One tag per line, with or without #. Notes with any matching tag are skipped.",
      )
      .addTextArea((text) => {
        text
          .setPlaceholder("nosync\nprivate")
          .setValue(this.plugin.settings.excludedTags.join("\n"))
          .onChange(async (value) => {
            this.plugin.settings.excludedTags = cleanList(
              value.split("\n"),
            ).map(normalizeTag);
            await this.plugin.saveSettings();
          });
      });
  }
}

function splitLines(content: string): string[] {
  return content.replace(/\r\n/g, "\n").split("\n");
}

function cleanList(values: string[]): string[] {
  return values
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function toTitleSource(value: string): TitleSource {
  if (value === "frontmatter" || value === "filename") {
    return value;
  }

  return "heading";
}

function getTitleSourceOrder(primarySource: TitleSource): TitleSource[] {
  const fallbackOrder: TitleSource[] = ["heading", "frontmatter", "filename"];
  return [
    primarySource,
    ...fallbackOrder.filter((source) => source !== primarySource),
  ];
}

function normalizeTitle(title: string): string {
  const normalized = title.trim().replace(/\s+/g, " ");
  return normalized.length > 0 ? normalized : "Untitled";
}

function toSafeFileBaseName(title: string): string {
  const safeBaseName = title
    .normalize("NFC")
    .toLowerCase()
    .trim()
    .replace(URL_UNSAFE_FILENAME_CHARS, "-")
    .replace(MULTIPLE_DASHES, "-")
    .replace(EDGE_DASHES, "");

  return safeBaseName.length > 0 ? safeBaseName : "untitled";
}

function findFirstH1(lines: string[]): HeadingMatch | null {
  const frontmatterRange = findFrontmatterRange(lines);
  const startLine =
    frontmatterRange === null ? 0 : frontmatterRange.endLine + 1;

  for (let index = startLine; index < lines.length; index += 1) {
    const match = lines[index].match(H1_PATTERN);

    if (match !== null) {
      return {
        lineIndex: index,
        title: match[1],
      };
    }
  }

  return null;
}

function findFrontmatterRange(lines: string[]): FrontmatterRange | null {
  if (lines[0] !== "---") {
    return null;
  }

  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index] === "---" || lines[index] === "...") {
      return {
        startLine: 0,
        endLine: index,
      };
    }
  }

  return null;
}

function withBlankLineAfterFrontmatter(content: string): string {
  const lineEnding = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = splitLines(content);
  ensureBlankLineAfterFrontmatter(lines);
  return lines.join(lineEnding);
}

function ensureBlankLineAfterFrontmatter(lines: string[]): void {
  const frontmatterRange = findFrontmatterRange(lines);

  if (frontmatterRange === null) {
    return;
  }

  const nextLineIndex = frontmatterRange.endLine + 1;
  if (lines[nextLineIndex] !== "") {
    lines.splice(nextLineIndex, 0, "");
  }
}

function readFrontmatterTitle(lines: string[]): string | null {
  const frontmatterRange = findFrontmatterRange(lines);

  if (frontmatterRange === null) {
    return null;
  }

  for (
    let index = frontmatterRange.startLine + 1;
    index < frontmatterRange.endLine;
    index += 1
  ) {
    const match = lines[index].match(/^title:\s*(.+)$/);

    if (match !== null) {
      return unwrapYamlString(match[1]);
    }
  }

  return null;
}

function readTags(content: string): string[] {
  const lines = splitLines(content);
  const frontmatterTags = readFrontmatterTags(lines);
  const bodyStartLine = findFrontmatterRange(lines)?.endLine ?? -1;
  const body = lines.slice(bodyStartLine + 1).join("\n");
  const inlineTags = [...body.matchAll(INLINE_TAG_PATTERN)].map(
    (match) => match[2],
  );

  return [...frontmatterTags, ...inlineTags];
}

function readFrontmatterTags(lines: string[]): string[] {
  const frontmatterRange = findFrontmatterRange(lines);

  if (frontmatterRange === null) {
    return [];
  }

  const tags: string[] = [];

  for (
    let index = frontmatterRange.startLine + 1;
    index < frontmatterRange.endLine;
    index += 1
  ) {
    const line = lines[index];
    const inlineTags = line.match(/^tags:\s*(.+)$/);
    const listTag = line.match(/^\s*-\s*(.+)$/);

    if (inlineTags !== null) {
      tags.push(...parseInlineFrontmatterTags(inlineTags[1]));
    }

    if (listTag !== null && isInsideTagsList(lines, index)) {
      tags.push(unwrapYamlString(listTag[1]));
    }
  }

  return tags;
}

function parseInlineFrontmatterTags(value: string): string[] {
  const trimmed = value.trim();

  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return cleanList(trimmed.slice(1, -1).split(",").map(unwrapYamlString));
  }

  return cleanList(trimmed.split(/\s+/).map(unwrapYamlString));
}

function isInsideTagsList(lines: string[], lineIndex: number): boolean {
  for (let index = lineIndex - 1; index >= 0; index -= 1) {
    const line = lines[index];

    if (line.match(/^tags:\s*$/) !== null) {
      return true;
    }

    if (line.trim().length > 0 && !line.startsWith(" ")) {
      return false;
    }
  }

  return false;
}

function normalizeTag(tag: string): string {
  return tag.trim().replace(/^#/, "").toLowerCase();
}

function isPathInFolder(filePath: string, folderPath: string): boolean {
  const normalizedFilePath = normalizePath(filePath);
  const normalizedFolderPath = normalizePath(folderPath).replace(
    /^\/+|\/+$/g,
    "",
  );

  return (
    normalizedFilePath === normalizedFolderPath ||
    normalizedFilePath.startsWith(`${normalizedFolderPath}/`)
  );
}

function unwrapYamlString(value: string): string {
  const trimmed = value.trim();
  const first = trimmed.at(0);
  const last = trimmed.at(-1);

  if ((first === `"` && last === `"`) || (first === `'` && last === `'`)) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}
