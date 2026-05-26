import {
  App,
  MarkdownView,
  Plugin,
  PluginSettingTab,
  Setting,
  SuggestModal,
  TFile,
  prepareFuzzySearch,
  prepareSimpleSearch,
  renderResults,
} from "obsidian";
import type { SearchMatches } from "obsidian";
import { StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";
import {
  buildSnippet,
  compareHits,
  enabledFields,
  headingPrefixLength,
  offsetToLineCh,
  rankFields,
  relativeTimeLabel,
  type FieldMatch,
  type SearchHit,
  type SearchScope,
} from "./search.ts";

// A single shared highlight decoration toggled by an effect. Registered once via
// registerEditorExtension; dispatched per-editor when a match is opened. An empty
// or null range clears it (a zero-length mark would throw, so it's guarded).
const setHighlightEffect = StateEffect.define<{ from: number; to: number } | null>();

const highlightField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(setHighlightEffect)) {
        const v = effect.value;
        deco =
          v === null || v.from >= v.to
            ? Decoration.none
            : Decoration.set([
                Decoration.mark({ class: "global-search-flash" }).range(v.from, v.to),
              ]);
      }
    }
    return deco;
  },
  provide: (field) => EditorView.decorations.from(field),
});

interface GlobalSearchSettings {
  searchScope: SearchScope; // which parts of a note to match
  showFilename: boolean; // show the note name in a result row
  showPath: boolean; // show the folder path in a result row
  showSnippet: boolean; // show the matched heading/line snippet
  highlightMode: "keep" | "timed" | "off"; // highlight persistence after opening
  openInNewTab: boolean; // open results in a new tab vs. the current one
}

const DEFAULT_SETTINGS: GlobalSearchSettings = {
  searchScope: "both",
  showFilename: true,
  showPath: true,
  showSnippet: true,
  highlightMode: "keep", // highlight and leave it until the next open
  openInNewTab: false,
};

export default class GlobalSearchPlugin extends Plugin {
  settings: GlobalSearchSettings = DEFAULT_SETTINGS;
  private clearHighlightTimer: number | null = null;
  private lastHighlightedView: EditorView | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.registerEditorExtension(highlightField);

    this.addCommand({
      id: "open-global-search",
      name: "Open global search",
      hotkeys: [{ modifiers: ["Mod", "Shift"], key: "k" }],
      callback: () => new GlobalSearchModal(this.app, this).open(),
    });

    this.addSettingTab(new GlobalSearchSettingTab(this.app, this));
  }

  onunload(): void {
    if (this.clearHighlightTimer !== null) {
      window.clearTimeout(this.clearHighlightTimer);
      this.clearHighlightTimer = null;
    }
    this.lastHighlightedView = null;
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  // Apply (or clear) the match highlight in a specific editor view, per the
  // configured highlightMode. "off" clears; "keep" leaves it until the next open;
  // "timed" clears it after 5 seconds. Any highlight left in a previously-opened
  // view is cleared first, so a new open never strands a highlight in another tab.
  highlightRange(view: EditorView, from: number, to: number): void {
    if (this.clearHighlightTimer !== null) {
      window.clearTimeout(this.clearHighlightTimer);
      this.clearHighlightTimer = null;
    }
    if (this.lastHighlightedView && this.lastHighlightedView !== view) {
      this.dispatchHighlight(this.lastHighlightedView, null);
    }
    this.lastHighlightedView = null;

    if (this.settings.highlightMode === "off") {
      this.dispatchHighlight(view, null);
      return;
    }
    this.dispatchHighlight(view, { from, to });
    this.lastHighlightedView = view;
    if (this.settings.highlightMode === "timed") {
      this.clearHighlightTimer = window.setTimeout(() => {
        this.dispatchHighlight(view, null);
        this.clearHighlightTimer = null;
        this.lastHighlightedView = null;
      }, 5000);
    }
  }

  // Dispatch the highlight effect, tolerating a view that was already torn down
  // (e.g. its tab was closed before the highlight could be cleared).
  private dispatchHighlight(
    view: EditorView,
    range: { from: number; to: number } | null,
  ): void {
    try {
      view.dispatch({ effects: setHighlightEffect.of(range) });
    } catch {
      // The view is gone; nothing to update.
    }
  }
}

class GlobalSearchModal extends SuggestModal<SearchHit> {
  private plugin: GlobalSearchPlugin;

  constructor(app: App, plugin: GlobalSearchPlugin) {
    super(app);
    this.plugin = plugin;
    this.setPlaceholder(`Search ${app.vault.getName()}…`);
    this.setInstructions([
      { command: "↑↓", purpose: "Navigate" },
      { command: "↵", purpose: "Open" },
      { command: "esc", purpose: "Dismiss" },
    ]);
    this.limit = 50;
    this.modalEl.addClass("global-search-modal");
  }

  async getSuggestions(query: string): Promise<SearchHit[]> {
    const q = query.trim();
    if (q.length === 0) {
      return buildRecentResults(this.app);
    }
    const fuzzy = prepareFuzzySearch(q);
    const simple = prepareSimpleSearch(q);
    return buildResults(
      this.app,
      fuzzy,
      simple,
      this.plugin.settings.searchScope,
    );
  }

  renderSuggestion(hit: SearchHit, el: HTMLElement): void {
    el.addClass("gs-result");
    const s = this.plugin.settings;
    // Force the filename whenever both the path and snippet are hidden, so a
    // result row is never left empty.
    const showFilename = s.showFilename || (!s.showPath && !s.showSnippet);

    const titleRow = el.createDiv({ cls: "gs-title-row" });

    if (showFilename) {
      const nameEl = titleRow.createSpan({ cls: "gs-title" });
      if (hit.titleMatches) {
        renderResults(nameEl, hit.file.basename, {
          score: hit.score,
          matches: hit.titleMatches,
        });
      } else {
        nameEl.setText(hit.file.basename);
      }
    }

    if (s.showPath) {
      const folder = hit.file.parent?.path ?? "";
      if (folder && folder !== "/") {
        titleRow.createSpan({ cls: "gs-path", text: `— ${prettyPath(folder)}` });
      }
    }

    if (hit.isRecent && hit.recentLabel) {
      titleRow.createSpan({ cls: "gs-recent-label", text: hit.recentLabel });
    }

    if (s.showSnippet && hit.snippet) {
      const snipEl = el.createDiv({ cls: "gs-snippet" });
      renderResults(snipEl, hit.snippet, {
        score: hit.score,
        matches: hit.snippetMatches,
      });
    }
  }

  onChooseSuggestion(hit: SearchHit, _evt: MouseEvent | KeyboardEvent): void {
    // Obsidian invokes this synchronously and ignores the return value, so we
    // run the async open separately and handle any failure here rather than
    // leaking an unhandled promise rejection.
    this.openHit(hit).catch((err) =>
      console.error("Global Search: failed to open file", err),
    );
  }

  private async openHit(hit: SearchHit): Promise<void> {
    const leaf = this.app.workspace.getLeaf(
      this.plugin.settings.openInNewTab ? "tab" : false,
    );
    // Open WITHOUT eState: passing { line } makes Obsidian apply its own yellow
    // "is-flashing" navigation highlight (--text-highlight-bg), a separate system
    // that conflicts with and outlives our configurable highlight. We scroll and
    // highlight the match ourselves below, so our decoration is the only highlight.
    await leaf.openFile(hit.file);

    if (hit.navLine != null && leaf.view instanceof MarkdownView) {
      const editor = leaf.view.editor;
      const from = { line: hit.navLine, ch: hit.navCh ?? 0 };
      const to = { line: hit.navLine, ch: (hit.navCh ?? 0) + hit.navLength };
      // Place the cursor at the match (navigation) and scroll it into view.
      editor.setSelection(from, from);
      editor.scrollIntoView({ from, to }, true);
      // Drive the animated highlight via the registered CM6 extension. `editor.cm`
      // is the underlying EditorView (the common community accessor; not in the
      // public d.ts, hence the cast).
      const cm = (editor as unknown as { cm?: EditorView }).cm;
      if (cm) {
        this.plugin.highlightRange(
          cm,
          editor.posToOffset(from),
          editor.posToOffset(to),
        );
      }
    }
  }
}

// Collapse a folder path to "first / … / last" so long breadcrumbs stay short.
function prettyPath(folder: string): string {
  const parts = folder.split("/").filter(Boolean);
  if (parts.length <= 2) return parts.join(" / ");
  return `${parts[0]} / … / ${parts[parts.length - 1]}`;
}

async function buildResults(
  app: App,
  fuzzy: ReturnType<typeof prepareFuzzySearch>,
  simple: ReturnType<typeof prepareSimpleSearch>,
  scope: SearchScope,
): Promise<SearchHit[]> {
  const hits: SearchHit[] = [];
  const scopeFlags = enabledFields(scope);
  // Heading navigation needs the raw line text, so read the body when either
  // headings or content is in scope; skip the read entirely for filenames-only.
  const needContent = scopeFlags.heading || scopeFlags.content;

  for (const file of app.vault.getMarkdownFiles()) {
    const titleRes = scopeFlags.title ? fuzzy(file.basename) : null;

    let headingHit:
      | { score: number; matches: SearchMatches; text: string; line: number; level: number }
      | null = null;
    if (scopeFlags.heading) {
      const cache = app.metadataCache.getFileCache(file);
      for (const h of cache?.headings ?? []) {
        const r = fuzzy(h.heading);
        if (r && (headingHit === null || r.score > headingHit.score)) {
          headingHit = {
            score: r.score,
            matches: r.matches,
            text: h.heading,
            line: h.position.start.line,
            level: h.level,
          };
        }
      }
    }

    let content = "";
    if (needContent) {
      try {
        content = await app.vault.cachedRead(file);
      } catch {
        continue; // file vanished mid-scan (e.g. sync race) — skip it
      }
    }

    let contentHit: { score: number; offset: number; length: number } | null = null;
    if (scopeFlags.content) {
      const contentRes = simple(content);
      if (contentRes && contentRes.matches.length > 0) {
        // Anchor snippet/navigation to the first match range.
        const [start, end] = contentRes.matches[0];
        contentHit = { score: contentRes.score, offset: start, length: end - start };
      }
    }

    const fieldMatches: FieldMatch[] = [];
    if (titleRes) fieldMatches.push({ type: "title", score: titleRes.score });
    if (headingHit) fieldMatches.push({ type: "heading", score: headingHit.score });
    if (contentHit) fieldMatches.push({ type: "content", score: contentHit.score });

    const best = rankFields(fieldMatches);
    if (best === null) continue;

    let snippet = "";
    let snippetMatches: SearchMatches = [];
    let navLine: number | null = null;
    let navCh: number | null = null;
    let navLength = 0;

    if (best.type === "heading" && headingHit) {
      snippet = headingHit.text;
      snippetMatches = headingHit.matches;
      navLine = headingHit.line;
      // Use the raw line's real prefix length so ATX headings (any spacing) and
      // setext headings (no "#" prefix) both land on the correct column.
      const rawLine = content.split("\n")[headingHit.line] ?? "";
      navCh = headingPrefixLength(rawLine) + (headingHit.matches[0]?.[0] ?? 0);
      navLength =
        headingHit.matches.length > 0
          ? headingHit.matches[0][1] - headingHit.matches[0][0]
          : 0;
    } else if (best.type === "content" && contentHit) {
      const snip = buildSnippet(content, contentHit.offset, contentHit.length);
      snippet = snip.text;
      snippetMatches = [[snip.matchStart, snip.matchStart + snip.matchLength]];
      const pos = offsetToLineCh(content, contentHit.offset);
      navLine = pos.line;
      navCh = pos.ch;
      navLength = contentHit.length;
    }

    hits.push({
      file,
      score: best.score,
      matchType: best.type,
      titleMatches: titleRes ? titleRes.matches : null,
      snippet,
      snippetMatches,
      navLine,
      navCh,
      navLength,
      isRecent: false,
      recentLabel: "",
    });
  }

  hits.sort(compareHits);
  return hits.slice(0, 50);
}

function buildRecentResults(app: App): SearchHit[] {
  const now = Date.now();
  const active = app.workspace.getActiveFile();
  const hits: SearchHit[] = [];

  for (const path of app.workspace.getLastOpenFiles()) {
    const file = app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile) || file.extension !== "md") continue;
    if (active && file.path === active.path) continue;

    hits.push({
      file,
      score: 0,
      matchType: "title",
      titleMatches: null,
      snippet: "",
      snippetMatches: [],
      navLine: null,
      navCh: null,
      navLength: 0,
      isRecent: true,
      recentLabel: relativeTimeLabel(file.stat.mtime, now),
    });
    if (hits.length >= 10) break;
  }

  return hits;
}

class GlobalSearchSettingTab extends PluginSettingTab {
  plugin: GlobalSearchPlugin;

  constructor(app: App, plugin: GlobalSearchPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;

    new Setting(containerEl)
      .setName("Keyboard shortcut")
      .setDesc(
        "Default: Cmd/Ctrl+Shift+K. Rebind it in Obsidian's Hotkeys settings.",
      )
      .addButton((btn) =>
        btn.setButtonText("Configure hotkey").onClick(() => {
          // `app.setting` is not in the public d.ts but is the standard accessor.
          const setting = (
            this.app as unknown as {
              setting?: { open(): void; openTabById(id: string): void };
            }
          ).setting;
          if (!setting) return;
          setting.open();
          setting.openTabById("hotkeys");
        }),
      );

    new Setting(containerEl)
      .setName("Search scope")
      .setDesc("Which parts of your notes to match against.")
      .addDropdown((dd) =>
        dd
          .addOption("filenames", "Filenames only")
          .addOption("content", "Content only")
          .addOption("both", "Filenames and content")
          .setValue(s.searchScope)
          .onChange(async (value) => {
            s.searchScope = value as SearchScope;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Show filename")
      .setDesc("Show each note's name in the result row.")
      .addToggle((t) =>
        t.setValue(s.showFilename).onChange(async (v) => {
          s.showFilename = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Show file path")
      .setDesc("Show the folder path next to the name.")
      .addToggle((t) =>
        t.setValue(s.showPath).onChange(async (v) => {
          s.showPath = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Show matched content")
      .setDesc("Show a snippet of the matched heading or line.")
      .addToggle((t) =>
        t.setValue(s.showSnippet).onChange(async (v) => {
          s.showSnippet = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Highlight on open")
      .setDesc("How the matched text is highlighted after you jump to it.")
      .addDropdown((dd) =>
        dd
          .addOption("keep", "Keep highlight")
          .addOption("timed", "Remove after 5 seconds")
          .addOption("off", "Don't highlight")
          .setValue(s.highlightMode)
          .onChange(async (value) => {
            s.highlightMode = value as GlobalSearchSettings["highlightMode"];
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Open results in a new tab")
      .setDesc(
        "When enabled, selecting a result opens the note in a new tab instead of the current one.",
      )
      .addToggle((t) =>
        t.setValue(s.openInNewTab).onChange(async (v) => {
          s.openInNewTab = v;
          await this.plugin.saveSettings();
        }),
      );
  }
}
