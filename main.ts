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
  TFolder,
} from "obsidian";

const URL_UNSAFE_FILENAME_CHARS = /[^\p{Letter}\p{Mark}\p{Number}]+/gu;
const SPECIAL_FILENAME_CHARS = /[^\p{Letter}\p{Mark}\p{Number}\p{Separator}_-]+/gu;
const MULTIPLE_DASHES = /-{2,}/g;
const EDGE_DASHES = /^-+|-+$/g;
const H1_PATTERN = /^#(?!#)\s+(.+?)\s*#*\s*$/;
const INLINE_TAG_PATTERN = /(^|\s)#([A-Za-z0-9_/-]+)/g;
const EDITOR_CHANGE_SYNC_DELAY_MS = 1_000;
const MAX_ENCODED_FILE_BASENAME_LENGTH = 180;
const FOLDER_NOTE_BASENAME = "index";

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
  autoSyncWhileEditing: boolean;
  titleSource: TitleSource;
  excludedTags: string[];
  excludedFolders: string[];
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
  autoSyncWhileEditing: false,
  titleSource: "heading",
  excludedTags: [],
  excludedFolders: [],
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
  private readonly recentlySyncedPaths = new Set<string>();
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
    this.addCommand({
      id: "resync-current-file-title",
      name: "Sync current file title",
      callback: () => {
        void this.syncCurrentFile();
      },
    });

    this.registerEvent(
      this.app.metadataCache.on("changed", (file) => {
        void this.handleMetadataChanged(file);
      }),
    );
  }

  onunload(): void {
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
      excludedFolders: cleanList(
        storedSettings?.excludedFolders ?? DEFAULT_SETTINGS.excludedFolders,
      ).map(normalizeFolderPath),
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

  private async handleMetadataChanged(file: TAbstractFile): Promise<void> {
    if (!this.isMarkdownFile(file)) {
      return;
    }

    if (
      !this.settings.enabled ||
      !this.settings.autoSyncWhileEditing ||
      this.isGloballyExcludedFile(file) ||
      !this.isActiveFile(file) ||
      this.recentlySyncedPaths.has(file.path) ||
      this.syncingPaths.has(file.path)
    ) {
      return;
    }

    await this.syncFile(file, { requireActiveFile: false });
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

  private async syncCurrentFile(): Promise<void> {
    const activeFile = this.app.workspace.getActiveFile();

    if (!this.isMarkdownFile(activeFile)) {
      new Notice("No active markdown file to sync.");
      return;
    }

    const didSync = await this.syncFile(activeFile);

    if (didSync) {
      new Notice("File Title Sync synced current file.");
    } else {
      new Notice("File Title Sync did not update current file.");
    }
  }

  private async syncFile(
    file: TFile,
    options: SyncFileOptions = { requireActiveFile: true },
  ): Promise<boolean> {
    const originalPath = file.path;

    if (
      !this.settings.enabled ||
      this.isGloballyExcludedFile(file) ||
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
      const renameTitle = selectRenameTitle({
        lines,
        canonicalTitle: title,
      });
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
      await this.renameFileIfNeeded(file, renameTitle, options);
      this.markRecentlySynced(file.path);
      return true;
    } finally {
      this.syncingPaths.delete(originalPath);
    }
  }

  private markRecentlySynced(path: string): void {
    this.recentlySyncedPaths.add(path);
    window.setTimeout(() => {
      this.recentlySyncedPaths.delete(path);
    }, EDITOR_CHANGE_SYNC_DELAY_MS);
  }

  private getCanonicalTitle(file: TFile, lines: string[]): string {
    return selectCanonicalTitle({
      primarySource: this.settings.titleSource,
      lines,
      fileBasename: getTitleFileBaseName(file),
    });
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
    const folderNote = isFolderNote(file);

    let renameTarget: TAbstractFile;
    let targetPath: string;

    if (folderNote) {
      const folder = file.parent;

      if (folder === null) {
        return;
      }

      renameTarget = folder;
      targetPath = await this.getAvailableFolderPath(folder, safeBaseName);
    } else {
      renameTarget = file;
      targetPath = await this.getAvailableFilePath(file, safeBaseName);
    }

    const currentPath = normalizePath(renameTarget.path);

    if (targetPath !== currentPath) {
      await this.app.fileManager.renameFile(renameTarget, targetPath);
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

  private async getAvailableFilePath(
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

  private async getAvailableFolderPath(
    folder: TFolder | null,
    safeBaseName: string,
  ): Promise<string> {
    if (folder === null) {
      return safeBaseName;
    }

    const parentFolderPath = folder.parent?.path ?? "";
    const folderPrefix =
      parentFolderPath === "/" || parentFolderPath === ""
        ? ""
        : `${parentFolderPath}/`;
    const currentPath = normalizePath(folder.path);
    let suffix = 0;

    while (true) {
      const candidateName = withSafeFileSuffix(safeBaseName, suffix);
      const candidatePath = normalizePath(`${folderPrefix}${candidateName}`);
      const existingFolder =
        this.app.vault.getAbstractFileByPath(candidatePath);

      if (candidatePath === currentPath || existingFolder === null) {
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

  private isGloballyExcludedFile(file: TFile): boolean {
    return isPathInExcludedFolders(file.path, this.settings.excludedFolders);
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
      .setName("Sync automatically while editing")
      .setDesc(
        "When enabled, the active note is synced after Obsidian modifies it while you edit. When disabled, sync runs only from the command palette.",
      )
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.autoSyncWhileEditing)
          .onChange(async (value) => {
            this.plugin.settings.autoSyncWhileEditing = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Source of truth")
      .setDesc(
        "When titles mismatch, this value wins. Metadata field behavior is described below.",
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

    containerEl.createEl("h3", { text: "Frontmatter metadata" });
    containerEl.createEl("p", {
      text: "These YAML frontmatter fields are used by File Title Sync:",
    });
    const metadataListEl = containerEl.createEl("ul");
    metadataListEl.createEl("li", {
      text: "title: synced with the selected source of truth and the first H1 heading.",
    });
    metadataListEl.createEl("li", {
      text: "filename: one-way rename metadata. When present and not blank, it takes priority for the actual filename, then still goes through the matching rename rule's slug or sanitize strategy. The plugin does not write back to filename.",
    });
    metadataListEl.createEl("li", {
      text: "tags: checked against excluded tags. Matching notes are skipped and are not synced or renamed.",
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

    new Setting(containerEl)
      .setName("Excluded folders")
      .setDesc(
        "One vault-relative folder path per line. Notes inside these folders are skipped before title, metadata, or filename sync runs.",
      )
      .addTextArea((text) => {
        text
          .setPlaceholder("Templates\nArchive/Imported")
          .setValue(this.plugin.settings.excludedFolders.join("\n"))
          .onChange(async (value) => {
            this.plugin.settings.excludedFolders = cleanList(
              value.split("\n"),
            ).map(normalizeFolderPath);
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
        "Slug lowercases and replaces special characters with dashes. Sanitize keeps case, but spaces and special characters become dashes.",
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

export function splitLines(content: string): string[] {
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

interface SelectCanonicalTitleInput {
  primarySource: TitleSource;
  lines: string[];
  fileBasename: string;
}

export function selectCanonicalTitle({
  primarySource,
  lines,
  fileBasename,
}: SelectCanonicalTitleInput): string {
  const titleCandidates: Record<TitleSource, string | null> = {
    heading: findFirstH1(lines)?.title ?? null,
    frontmatter: readFrontmatterTitle(lines),
    filename: fileBasename,
  };

  for (const source of getTitleSourceOrder(primarySource)) {
    const candidate = titleCandidates[source];

    if (candidate !== null && candidate.trim().length > 0) {
      return normalizeTitle(candidate);
    }
  }

  return "Untitled";
}

interface SelectRenameTitleInput {
  lines: string[];
  canonicalTitle: string;
}

export function selectRenameTitle({
  lines,
  canonicalTitle,
}: SelectRenameTitleInput): string {
  const frontmatterFilename = readFrontmatterFilename(lines);

  if (
    frontmatterFilename !== null &&
    frontmatterFilename.trim().length > 0
  ) {
    return normalizeTitle(frontmatterFilename);
  }

  return canonicalTitle;
}

export function isFolderNote(file: Pick<TFile, "basename" | "parent">): boolean {
  return (
    file.basename === FOLDER_NOTE_BASENAME &&
    file.parent !== null &&
    file.parent.path.length > 0 &&
    file.parent.path !== "/"
  );
}

export function getTitleFileBaseName(file: Pick<TFile, "basename" | "parent">): string {
  const parent = file.parent;

  if (
    file.basename !== FOLDER_NOTE_BASENAME ||
    parent === null ||
    parent.path.length === 0 ||
    parent.path === "/"
  ) {
    return file.basename;
  }

  return parent.name;
}

export function getFolderNoteRenameTargetPath(
  file: Pick<TFile, "basename" | "parent">,
  safeBaseName: string,
  suffix = 0,
): string {
  if (!isFolderNote(file) || file.parent === null) {
    return safeBaseName;
  }

  const parentFolderPath = file.parent.parent?.path ?? "";
  const folderPrefix =
    parentFolderPath === "/" || parentFolderPath === ""
      ? ""
      : `${parentFolderPath}/`;

  return normalizePath(
    `${folderPrefix}${withSafeFileSuffix(safeBaseName, suffix)}`,
  );
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

export function buildFileBaseName(
  title: string,
  strategy: RenameStrategy,
): string {
  return strategy === "sanitize"
    ? toSanitizedFileBaseName(title)
    : toSlugFileBaseName(title);
}

function toSlugFileBaseName(title: string): string {
  const safeBaseName = toDashSeparatedFileBaseName(title.toLowerCase());
  return truncateToEncodedLength(
    safeBaseName.length > 0 ? safeBaseName : "untitled",
    MAX_ENCODED_FILE_BASENAME_LENGTH,
  );
}

function toSanitizedFileBaseName(title: string): string {
  const safeBaseName = toDashSeparatedFileBaseName(title);
  return truncateToEncodedLength(
    safeBaseName.length > 0 ? safeBaseName : "Untitled",
    MAX_ENCODED_FILE_BASENAME_LENGTH,
  );
}

function toDashSeparatedFileBaseName(title: string): string {
  return title
    .normalize("NFC")
    .trim()
    .replace(SPECIAL_FILENAME_CHARS, "-")
    .replace(URL_UNSAFE_FILENAME_CHARS, "-")
    .replace(MULTIPLE_DASHES, "-")
    .replace(EDGE_DASHES, "");
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

export function readFrontmatterTitle(lines: string[]): string | null {
  return readFrontmatterString(lines, "title");
}

function readFrontmatterFilename(lines: string[]): string | null {
  return readFrontmatterString(lines, "filename");
}

function readFrontmatterString(
  lines: string[],
  key: "title" | "filename",
): string | null {
  const frontmatterRange = findFrontmatterRange(lines);

  if (frontmatterRange === null) {
    return null;
  }

  for (
    let index = frontmatterRange.startLine + 1;
    index < frontmatterRange.endLine;
    index += 1
  ) {
    const match = lines[index].match(new RegExp(`^${key}:\\s*(.+)$`));

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

export function isPathInExcludedFolders(
  filePath: string,
  excludedFolders: string[],
): boolean {
  return excludedFolders.some((folder) => isPathInFolder(filePath, folder));
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
