import {
  App,
  Modal,
  Notice,
  normalizePath,
  Plugin,
  PluginSettingTab,
  Setting,
  TAbstractFile,
  TFile,
} from "obsidian";

const URL_UNSAFE_FILENAME_CHARS = /[^\p{Letter}\p{Mark}\p{Number}]+/gu;
const SPECIAL_FILENAME_CHARS = /[^\p{Letter}\p{Mark}\p{Number}\p{Separator}_-]+/gu;
const MULTIPLE_DASHES = /-{2,}/g;
const EDGE_DASHES = /^-+|-+$/g;
const MULTIPLE_SPACES = /\s{2,}/g;
const H1_PATTERN = /^#(?!#)\s+(.+?)\s*#*\s*$/;
const INLINE_TAG_PATTERN = /(^|\s)#([A-Za-z0-9_/-]+)/g;
const EDITOR_CHANGE_SYNC_DELAY_MS = 1_000;
const MAX_ENCODED_FILE_BASENAME_LENGTH = 180;

type TitleSource = "heading" | "frontmatter" | "filename";
type RenameStrategy = "slug" | "sanitize";

interface RenameRule {
  folder: string;
  strategy: RenameStrategy;
  enabled: boolean;
  excludedFolders: string[];
  includedFiles: string[];
  excludedFiles: string[];
}

interface FileTitleSyncSettings {
  enabled: boolean;
  titleSource: TitleSource;
  excludedTags: string[];
  renameRules: RenameRule[];
}

const DEFAULT_RENAME_RULE: RenameRule = {
  folder: "",
  strategy: "slug",
  enabled: true,
  excludedFolders: [],
  includedFiles: [],
  excludedFiles: [],
};

const DEFAULT_SETTINGS: FileTitleSyncSettings = {
  enabled: true,
  titleSource: "heading",
  excludedTags: [],
  renameRules: [],
};

const TITLE_SOURCE_LABELS: Record<TitleSource, string> = {
  heading: "First H1 heading",
  frontmatter: "Title frontmatter",
  filename: "Filename",
};

const RENAME_STRATEGY_LABELS: Record<RenameStrategy, string> = {
  slug: "Slug",
  sanitize: "Sanitize",
};

interface FrontmatterRange {
  startLine: number;
  endLine: number;
}

interface HeadingMatch {
  lineIndex: number;
  title: string;
}

interface SyncFileOptions {
  requireActiveFile: boolean;
}

interface StoredFileTitleSyncSettings
  extends Omit<FileTitleSyncSettings, "renameRules"> {
  renameRules?: Partial<RenameRule>[];
}

export default class FileTitleSyncPlugin extends Plugin {
  private readonly syncingPaths = new Set<string>();
  private readonly pendingSyncTimers = new Map<string, number>();
  settings: FileTitleSyncSettings = DEFAULT_SETTINGS;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new FileTitleSyncSettingTab(this.app, this));
    this.addCommand({
      id: "resync-all-file-titles",
      name: "Resync all file titles",
      callback: () => {
        void this.resyncAllFiles();
      },
    });

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
      (await this.loadData()) as Partial<StoredFileTitleSyncSettings> | null;

    this.settings = {
      ...DEFAULT_SETTINGS,
      ...storedSettings,
      excludedTags: cleanList(
        storedSettings?.excludedTags ?? DEFAULT_SETTINGS.excludedTags,
      ).map(normalizeTag),
      renameRules: (
        storedSettings?.renameRules ?? DEFAULT_SETTINGS.renameRules
      ).map((rule) => normalizeRenameRule(rule)),
    };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  async addRenameRule(): Promise<void> {
    this.settings.renameRules = [
      ...this.settings.renameRules,
      createRenameRule(),
    ];
    await this.saveSettings();
  }

  async updateRenameRule(
    index: number,
    updater: (rule: RenameRule) => RenameRule,
  ): Promise<void> {
    this.settings.renameRules = this.settings.renameRules.map((rule, ruleIndex) =>
      ruleIndex === index ? normalizeRenameRule(updater(rule)) : rule,
    );
    await this.saveSettings();
  }

  async removeRenameRule(index: number): Promise<void> {
    this.settings.renameRules = this.settings.renameRules.filter(
      (_rule, ruleIndex) => ruleIndex !== index,
    );
    await this.saveSettings();
  }

  private isMarkdownFile(file: TAbstractFile | null): file is TFile {
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

  private async resyncAllFiles(): Promise<void> {
    if (!this.settings.enabled) {
      new Notice("File Title Sync is disabled.");
      return;
    }

    const files = this.app.vault.getMarkdownFiles();
    let syncedCount = 0;

    for (const file of files) {
      const currentFile = this.app.vault.getAbstractFileByPath(file.path);

      if (!this.isMarkdownFile(currentFile)) {
        continue;
      }

      const didSync = await this.syncFile(currentFile, {
        requireActiveFile: false,
      });

      if (didSync) {
        syncedCount += 1;
      }
    }

    const fileLabel = syncedCount === 1 ? "file" : "files";
    new Notice(`File Title Sync reprocessed ${syncedCount} ${fileLabel}.`);
  }

  private async syncFile(
    file: TFile,
    options: SyncFileOptions = { requireActiveFile: true },
  ): Promise<boolean> {
    const originalPath = file.path;

    if (
      !this.settings.enabled ||
      (options.requireActiveFile && !this.isActiveFile(file)) ||
      this.syncingPaths.has(originalPath)
    ) {
      return false;
    }

    this.syncingPaths.add(originalPath);

    try {
      const content = await this.app.vault.cachedRead(file);
      if (this.hasExcludedTag(content)) {
        return false;
      }

      const lines = splitLines(content);
      const title = this.getCanonicalTitle(file, lines);
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
      await this.renameFileIfNeeded(file, title, options);
      return true;
    } finally {
      this.syncingPaths.delete(originalPath);
    }
  }

  private getCanonicalTitle(file: TFile, lines: string[]): string {
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

    if (nextContent !== content) {
      await this.app.vault.process(file, withBlankLineAfterFrontmatter);
    }
  }

  private async renameFileIfNeeded(
    file: TFile,
    title: string,
    options: SyncFileOptions,
  ): Promise<void> {
    if (options.requireActiveFile && !this.isActiveFile(file)) {
      return;
    }

    const rule = this.getMatchingRenameRule(file);

    if (rule === null) {
      return;
    }

    const safeBaseName = buildFileBaseName(title, rule.strategy);
    const targetPath = await this.getAvailablePath(file, safeBaseName);

    if (targetPath !== file.path) {
      await this.app.fileManager.renameFile(file, targetPath);
    }
  }

  private getMatchingRenameRule(file: TFile): RenameRule | null {
    for (const rule of this.settings.renameRules) {
      if (matchesRenameRule(file, rule)) {
        return rule;
      }
    }

    return null;
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
      const candidateName = withSafeFileSuffix(safeBaseName, suffix);
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
      .setDesc(
        "When disabled, the plugin will not sync headings, frontmatter, or filenames.",
      )
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

    containerEl.createEl("h3", { text: "Rename rules" });
    containerEl.createEl("p", {
      text: "Rules are checked from top to bottom. The first matching folder rule decides how the filename is renamed.",
    });

    this.plugin.settings.renameRules.forEach((rule, index) => {
      this.renderRenameRule(index, rule);
    });

    new Setting(containerEl)
      .setName("Add rename rule")
      .setDesc("Create a new folder-scoped rename rule.")
      .addButton((button) => {
        button.setButtonText("Add rule").onClick(async () => {
          await this.plugin.addRenameRule();
          this.display();
        });
      });
  }

  private renderRenameRule(index: number, rule: RenameRule): void {
    const sectionEl = this.containerEl.createDiv("file-title-sync-rule");
    new Setting(sectionEl)
      .setName(`Rule ${index + 1}`)
      .setDesc(describeRenameRule(rule))
      .addButton((button) => {
        button.setButtonText("Edit").onClick(() => {
          new RenameRuleModal(this.app, rule, async (nextRule) => {
            await this.plugin.updateRenameRule(index, () => nextRule);
            this.display();
          }).open();
        });
      })
      .addExtraButton((button) => {
        button
          .setIcon("up-chevron-glyph")
          .setTooltip("Move up")
          .onClick(async () => {
            await this.moveRule(index, -1);
          });
      })
      .addExtraButton((button) => {
        button
          .setIcon("down-chevron-glyph")
          .setTooltip("Move down")
          .onClick(async () => {
            await this.moveRule(index, 1);
          });
      })
      .addExtraButton((button) => {
        button
          .setIcon(rule.enabled ? "check-circle" : "circle-slash")
          .setTooltip(rule.enabled ? "Disable rule" : "Enable rule")
          .onClick(async () => {
            await this.plugin.updateRenameRule(index, (currentRule) => ({
              ...currentRule,
              enabled: !currentRule.enabled,
            }));
            this.display();
          });
      })
      .addButton((button) => {
        button.setWarning().setButtonText("Remove").onClick(async () => {
          await this.plugin.removeRenameRule(index);
          this.display();
        });
      });
  }

  private async moveRule(index: number, direction: -1 | 1): Promise<void> {
    const nextIndex = index + direction;

    if (
      nextIndex < 0 ||
      nextIndex >= this.plugin.settings.renameRules.length
    ) {
      return;
    }

    const nextRules = [...this.plugin.settings.renameRules];
    const [rule] = nextRules.splice(index, 1);
    nextRules.splice(nextIndex, 0, rule);
    this.plugin.settings.renameRules = nextRules;
    await this.plugin.saveSettings();
    this.display();
  }
}

class RenameRuleModal extends Modal {
  private draftRule: RenameRule;

  constructor(
    app: App,
    rule: RenameRule,
    private readonly onSaveRule: (rule: RenameRule) => Promise<void>,
  ) {
    super(app);
    this.draftRule = { ...rule };
  }

  onOpen(): void {
    const { contentEl, titleEl } = this;
    titleEl.setText("Edit rename rule");
    contentEl.empty();

    new Setting(contentEl)
      .setName("Folder")
      .setDesc(
        "Vault-relative folder path for this rule. Leave blank to match all folders. Subfolders inherit the rule.",
      )
      .addText((text) => {
        text
          .setPlaceholder("Writing")
          .setValue(this.draftRule.folder)
          .onChange((value) => {
            this.draftRule.folder = value.trim();
          });
      });

    new Setting(contentEl)
      .setName("Strategy")
      .setDesc(
        "Slug lowercases and replaces special characters with dashes. Sanitize keeps case and spaces, and only removes special characters.",
      )
      .addDropdown((dropdown) => {
        Object.entries(RENAME_STRATEGY_LABELS).forEach(([value, label]) => {
          dropdown.addOption(value, label);
        });

        dropdown.setValue(this.draftRule.strategy).onChange((value) => {
          this.draftRule.strategy = toRenameStrategy(value);
        });
      });

    new Setting(contentEl)
      .setName("Enabled")
      .setDesc("Disable this rule without deleting it.")
      .addToggle((toggle) => {
        toggle.setValue(this.draftRule.enabled).onChange((value) => {
          this.draftRule.enabled = value;
        });
      });

    new Setting(contentEl)
      .setName("Excluded folders")
      .setDesc(
        "One folder path per line. Notes inside these folders are skipped even when they are inside the main folder.",
      )
      .addTextArea((text) => {
        text
          .setPlaceholder("Writing/Templates")
          .setValue(this.draftRule.excludedFolders.join("\n"))
          .onChange((value) => {
            this.draftRule.excludedFolders = cleanList(value.split("\n"));
          });
      });

    new Setting(contentEl)
      .setName("Included files")
      .setDesc(
        "One vault-relative file path per line. When set, only these files can use this rule.",
      )
      .addTextArea((text) => {
        text
          .setPlaceholder("Writing/My Note.md")
          .setValue(this.draftRule.includedFiles.join("\n"))
          .onChange((value) => {
            this.draftRule.includedFiles = cleanList(value.split("\n"));
          });
      });

    new Setting(contentEl)
      .setName("Excluded files")
      .setDesc(
        "One vault-relative file path per line. Matching files are skipped by this rule.",
      )
      .addTextArea((text) => {
        text
          .setPlaceholder("Writing/Templates/Daily.md")
          .setValue(this.draftRule.excludedFiles.join("\n"))
          .onChange((value) => {
            this.draftRule.excludedFiles = cleanList(value.split("\n"));
          });
      });

    new Setting(contentEl)
      .addButton((button) => {
        button.setButtonText("Cancel").onClick(() => {
          this.close();
        });
      })
      .addButton((button) => {
        button.setCta().setButtonText("Save").onClick(async () => {
          await this.onSaveRule(this.draftRule);
          this.close();
        });
      });
  }

  onClose(): void {
    this.contentEl.empty();
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

function createRenameRule(): RenameRule {
  return {
    ...DEFAULT_RENAME_RULE,
  };
}

function normalizeRenameRule(rule: Partial<RenameRule> | undefined): RenameRule {
  return {
    folder: normalizeFolderPath(rule?.folder ?? DEFAULT_RENAME_RULE.folder),
    strategy: toRenameStrategy(rule?.strategy),
    enabled: rule?.enabled ?? DEFAULT_RENAME_RULE.enabled,
    excludedFolders: cleanList(
      rule?.excludedFolders ?? DEFAULT_RENAME_RULE.excludedFolders,
    ).map(normalizeFolderPath),
    includedFiles: cleanList(
      rule?.includedFiles ?? DEFAULT_RENAME_RULE.includedFiles,
    ).map(normalizePath),
    excludedFiles: cleanList(
      rule?.excludedFiles ?? DEFAULT_RENAME_RULE.excludedFiles,
    ).map(normalizePath),
  };
}

function toTitleSource(value: string): TitleSource {
  if (value === "frontmatter" || value === "filename") {
    return value;
  }

  return "heading";
}

function toRenameStrategy(value: string | undefined): RenameStrategy {
  return value === "sanitize" ? "sanitize" : "slug";
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

function describeRenameRule(rule: RenameRule): string {
  const folder = rule.folder.length > 0 ? rule.folder : "All folders";
  const details = [
    rule.enabled ? "Enabled" : "Disabled",
    `folder: ${folder}`,
    `strategy: ${RENAME_STRATEGY_LABELS[rule.strategy]}`,
  ];

  if (rule.excludedFolders.length > 0) {
    details.push(`excluded folders: ${rule.excludedFolders.length}`);
  }

  if (rule.includedFiles.length > 0) {
    details.push(`included files: ${rule.includedFiles.length}`);
  }

  if (rule.excludedFiles.length > 0) {
    details.push(`excluded files: ${rule.excludedFiles.length}`);
  }

  return details.join(" • ");
}

function buildFileBaseName(
  title: string,
  strategy: RenameStrategy,
): string {
  return strategy === "sanitize"
    ? toSanitizedFileBaseName(title)
    : toSlugFileBaseName(title);
}

function toSlugFileBaseName(title: string): string {
  const safeBaseName = title
    .normalize("NFC")
    .toLowerCase()
    .trim()
    .replace(URL_UNSAFE_FILENAME_CHARS, "-")
    .replace(MULTIPLE_DASHES, "-")
    .replace(EDGE_DASHES, "");

  return truncateToEncodedLength(
    safeBaseName.length > 0 ? safeBaseName : "untitled",
    MAX_ENCODED_FILE_BASENAME_LENGTH,
  );
}

function toSanitizedFileBaseName(title: string): string {
  const safeBaseName = title
    .normalize("NFC")
    .trim()
    .replace(SPECIAL_FILENAME_CHARS, "")
    .replace(MULTIPLE_SPACES, " ")
    .trim();

  return truncateToEncodedLength(
    safeBaseName.length > 0 ? safeBaseName : "Untitled",
    MAX_ENCODED_FILE_BASENAME_LENGTH,
  );
}

function withSafeFileSuffix(safeBaseName: string, suffix: number): string {
  if (suffix === 0) {
    return safeBaseName;
  }

  const suffixText = `-${suffix + 1}`;
  const maxBaseLength =
    MAX_ENCODED_FILE_BASENAME_LENGTH - getEncodedLength(suffixText);
  const truncatedBaseName = truncateToEncodedLength(
    safeBaseName,
    maxBaseLength,
  );

  return `${truncatedBaseName}${suffixText}`;
}

function truncateToEncodedLength(value: string, maxEncodedLength: number): string {
  let result = "";
  let encodedLength = 0;

  for (const char of value) {
    const nextEncodedLength = encodedLength + getEncodedLength(char);

    if (nextEncodedLength > maxEncodedLength) {
      break;
    }

    result += char;
    encodedLength = nextEncodedLength;
  }

  const trimmed = result.replace(EDGE_DASHES, "").trim();
  return trimmed.length > 0 ? trimmed : "untitled";
}

function getEncodedLength(value: string): number {
  return encodeURIComponent(value).length;
}

function matchesRenameRule(file: TFile, rule: RenameRule): boolean {
  if (!rule.enabled) {
    return false;
  }

  if (rule.folder.length > 0 && !isPathInFolder(file.path, rule.folder)) {
    return false;
  }

  if (
    rule.excludedFolders.some((folder) => isPathInFolder(file.path, folder))
  ) {
    return false;
  }

  if (
    rule.includedFiles.length > 0 &&
    !rule.includedFiles.some((path) => isSameFilePath(file.path, path))
  ) {
    return false;
  }

  if (rule.excludedFiles.some((path) => isSameFilePath(file.path, path))) {
    return false;
  }

  return true;
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

function normalizeFolderPath(value: string): string {
  return normalizePath(value).replace(/^\/+|\/+$/g, "");
}

function isPathInFolder(filePath: string, folderPath: string): boolean {
  const normalizedFilePath = normalizePath(filePath);
  const normalizedFolderPath = normalizeFolderPath(folderPath);

  return (
    normalizedFilePath === normalizedFolderPath ||
    normalizedFilePath.startsWith(`${normalizedFolderPath}/`)
  );
}

function isSameFilePath(left: string, right: string): boolean {
  return normalizePath(left) === normalizePath(right);
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
