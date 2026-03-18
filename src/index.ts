import type { BundledLanguage, BundledTheme, HighlighterCore, ThemedToken } from "shiki";
import pose from "poseui";

declare const scheduler: { yield(): Promise<void> } | undefined;

// ─── Types ────────────────────────────────────────────────────────────────────

type GrammarState = NonNullable<ReturnType<HighlighterCore["codeToTokens"]>["grammarState"]>;

interface LineRecord {
  text: string;
  html: string;
  grammarState: GrammarState | undefined;
  grammarHash: string;
  dirty: boolean;
}

export interface ShikiEditorOptions {
  shiki: HighlighterCore;
  lang: BundledLanguage;
  themes: Record<string, BundledTheme>;
  defaultTheme?: string;
  lineHeight?: number;
  tabSize?: number;
  onChange?: (value: string) => void;
  lineNumber?: "absolute" | "relative" | false;
}

export interface ShikiEditorHandle {
  setValue(value: string): void;
  getValue(): string;
  dispose(): void;
}

// ─── Utils ────────────────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function hashState(state: GrammarState | undefined): string {
  if (!state) return "";
  try {
    const scopes = state.getScopes();
    return scopes ? scopes.join("|") : "";
  } catch {
    return "";
  }
}

function yieldToMain(): Promise<void> {
  if (typeof scheduler !== "undefined" && "yield" in scheduler) {
    return scheduler.yield();
  }
  return new Promise((r) => setTimeout(r, 0));
}

// ─── Diff ─────────────────────────────────────────────────────────────────────

/**
 * Returns [start, oldEnd, newEnd] describing the changed region.
 * Avoids allocating new arrays — works directly with the line records
 * and the new text lines.
 */
function diffLines(oldLines: LineRecord[], newLines: string[]): [number, number, number] {
  const oldLen = oldLines.length;
  const newLen = newLines.length;

  let start = 0;
  while (start < oldLen && start < newLen && oldLines[start]!.text === newLines[start]) {
    start++;
  }

  let oldEnd = oldLen;
  let newEnd = newLen;
  while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1]!.text === newLines[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }

  return [start, oldEnd, newEnd];
}

// ─── Renderer ─────────────────────────────────────────────────────────────────

function tokensToHtml(
  tokens: ThemedToken[],
  themes: Record<string, BundledTheme>,
  defaultTheme: string,
): string {
  if (!tokens.length) return "\n";

  let html = "";
  for (const token of tokens) {
    const escaped = escapeHtml(token.content);
    const style = token.htmlStyle;

    if (!style) {
      html += escaped;
      continue;
    }

    // Handle string style (single theme)
    if (typeof style === "string") {
      html += `<span style="${style}">${escaped}</span>`;
      continue;
    }

    // Handle object style (multiple themes)
    const styles: string[] = [];
    for (const theme in style) {
      const color = (style as Record<string, string>)[theme];
      if (!color) continue;
      if (theme === defaultTheme) {
        styles.unshift(`color:${color}`);
      } else {
        styles.push(`--shiki-${theme}:${color}`);
      }
    }

    html += styles.length ? `<span style="${styles.join(";")}">${escaped}</span>` : escaped;
  }

  return html + "\n";
}

// ─── Core ─────────────────────────────────────────────────────────────────────

export function createShikiEditor(
  container: HTMLElement,
  options: ShikiEditorOptions,
): ShikiEditorHandle {
  const {
    shiki,
    lang,
    themes,
    defaultTheme = Object.keys(themes)[0]!,
    lineHeight = 22,
    tabSize = 2,
    onChange,
    lineNumber = false,
  } = options;

  // ── State ──────────────────────────────────────────────────────────────────

  let lines: LineRecord[] = [];
  let tokenizeAbortController = new AbortController();
  let value = "";
  let disposed = false;

  // ── DOM Setup ──────────────────────────────────────────────────────────────
  //
  // Architecture: a single scrollable textarea handles editing and scrolling.
  // A `<pre>` mirror is layered behind it (pointer-events: none) and kept in
  // sync via scroll events. The mirror contains all highlighted HTML; the
  // browser handles soft-wrap layout identically in both elements.

  const gutterWidth = lineNumber ? 48 : 0;

  container.style.cssText = `
    position: relative;
    overflow: hidden;
    width: 100%;
    height: 100%;
    font-family: ui-monospace, "JetBrains Mono", "Fira Code", monospace;
    font-size: 14px;
    line-height: ${lineHeight}px;
  `;

  const uid = "shedit-" + Math.random().toString(36).slice(2, 8);

  const mirrorComponent = pose
    .as("pre")
    .attr("id", "shedit-mirror")
    .attr(
      "style",
      `
        position: absolute;
        top: 0; left: ${gutterWidth}px; right: 0; bottom: 0;
        margin: 0;
        padding: 1rem;
        border: none;
        pointer-events: none;
        user-select: none;
        white-space: pre-wrap;
        word-wrap: break-word;
        overflow: auto;
        box-sizing: border-box;
        z-index: 0;
        font-family: inherit;
        font-size: inherit;
        line-height: inherit;
      `,
    )
    .cls(uid);

  const scrollbarStyle = document.createElement("style");
  scrollbarStyle.textContent = `
    .${uid}::-webkit-scrollbar { display: none; }
    .${uid} { scrollbar-width: none; }
  `;
  container.appendChild(scrollbarStyle);

  const caretColor = getComputedStyle(container).color || "#24292e";

  const textareaComponent = pose
    .as("textarea")
    .attr("id", "shedit-textarea")
    .attr("spellcheck", "false")
    .attr("autocomplete", "off")
    .attr("autocorrect", "off")
    .attr("autocapitalize", "off")
    .attr(
      "style",
      `
        position: absolute;
        top: 0; left: ${gutterWidth}px; right: 0; bottom: 0;
        display: block;
        width: calc(100% - ${gutterWidth}px);
        height: 100%;
        margin: 0;
        padding: 1rem;
        font-family: inherit;
        font-size: inherit;
        line-height: inherit;
        tab-size: ${tabSize};
        white-space: pre-wrap;
        word-wrap: break-word;
        resize: none;
        border: none;
        outline: none;
        background: transparent;
        color: transparent;
        caret-color: ${caretColor};
        box-sizing: border-box;
        overflow: auto;
        z-index: 1;
      `,
    );

  const gutterComponent = pose
    .as("div")
    .attr("id", "shedit-gutter")
    .attr(
      "style",
      lineNumber
        ? `
            position: absolute;
            top: 0; left: 0; bottom: 0;
            width: ${gutterWidth}px;
            padding: 1rem 0.5rem;
            overflow: hidden;
            box-sizing: border-box;
            text-align: right;
            font-family: inherit;
            font-size: inherit;
            line-height: inherit;
            color: ${caretColor};
            opacity: 0.5;
            user-select: none;
            cursor: pointer;
            z-index: 2;
          `
        : "display: none;",
    );

  container.insertAdjacentHTML("beforeend", gutterComponent());
  container.insertAdjacentHTML("beforeend", mirrorComponent());
  container.insertAdjacentHTML("beforeend", textareaComponent());

  const gutter = container.querySelector<HTMLDivElement>("#shedit-gutter");
  const mirror = container.querySelector<HTMLPreElement>("#shedit-mirror");
  const textarea = container.querySelector<HTMLTextAreaElement>("#shedit-textarea");

  // ── Viewport rendering ─────────────────────────────────────────────────────
  //
  // Both the textarea and the mirror use pre-wrap with identical font/padding,
  // so soft-wrap is identical in both. We render ALL highlighted HTML into the
  // mirror and let the browser handle layout. The textarea scrolls; we sync
  // the mirror's scrollTop to match.

  function getLineNumberHtml(lineIndex: number, cursorLine: number): string {
    if (!lineNumber) return "";

    let num: number;
    if (lineNumber === "absolute") {
      num = lineIndex + 1;
    } else {
      // relative - shows distance from cursor line (0 on current line)
      num = Math.abs(lineIndex - cursorLine);
    }
    return `<div style="height:${lineHeight}px;line-height:${lineHeight}px">${num}</div>`;
  }

  function renderGutter() {
    if (!lineNumber) return;
    if (!textarea) return;
    if (!gutter) return;

    // Find cursor line based on selection
    const cursorPos = textarea.selectionStart ?? 0;
    const textBeforeCursor = textarea.value.slice(0, cursorPos);
    const cursorLine = textBeforeCursor.split("\n").length - 1;

    let html = "";
    for (let i = 0; i < lines.length; i++) {
      html += getLineNumberHtml(i, cursorLine);
    }
    gutter.innerHTML = html;
    gutter.scrollTop = textarea.scrollTop;
  }

  function renderViewport() {
    if (!textarea) return;
    if (!mirror) return;

    // Full render — the browser handles soft-wrap layout for us.
    // For very large documents (10k+ lines) this could be swapped for a
    // measured virtualisation pass, but for typical editor use (<5k lines)
    // a full innerHTML write is fast enough (~1-3ms).
    let html = "";
    for (let i = 0; i < lines.length; i++) {
      html += lines[i]!.html;
    }
    mirror.innerHTML = html;

    // Sync scroll position so highlight aligns with textarea caret.
    mirror.scrollTop = textarea.scrollTop;
    mirror.scrollLeft = textarea.scrollLeft;

    renderGutter();
  }

  // ── Tokenizer ──────────────────────────────────────────────────────────────

  async function tokenizeFrom(startLine: number, signal: AbortSignal) {
    let changed = false;

    for (let i = startLine; i < lines.length; i++) {
      if (signal.aborted) return;

      const line = lines[i];
      if (!line) continue;

      const prevState = i > 0 ? lines[i - 1]?.grammarState : undefined;
      const prevHash = hashState(prevState);

      // If this line is clean and its input grammar state hasn't changed,
      // no lines after it can change either — stop early.
      if (!line.dirty && line.grammarHash === prevHash) break;

      let result: ReturnType<typeof shiki.codeToTokens>;
      try {
        result = shiki.codeToTokens(line.text, {
          lang,
          themes,
          defaultColor: false,
          cssVariablePrefix: "",
          grammarState: prevState,
        });
      } catch {
        line.dirty = false;
        continue;
      }

      const newHash = hashState(result.grammarState);
      line.grammarState = result.grammarState;
      line.grammarHash = newHash;
      line.html = tokensToHtml(result.tokens[0] ?? [], themes, defaultTheme);
      line.dirty = false;
      changed = true;

      // Yield periodically to keep the main thread responsive.
      if (i % 50 === 0 && changed) {
        renderViewport();
        changed = false;
        await yieldToMain();
      }
    }

    if (!signal.aborted && changed) {
      renderViewport();
    }
  }

  function scheduleTokenize(fromLine: number) {
    tokenizeAbortController.abort();
    tokenizeAbortController = new AbortController();
    tokenizeFrom(fromLine, tokenizeAbortController.signal);
  }

  // ── Edit Handling ──────────────────────────────────────────────────────────

  function applyEdit(newValue: string) {
    const newLineTexts = newValue.split("\n");
    const [start, oldEnd, newEnd] = diffLines(lines, newLineTexts);

    const replacements: LineRecord[] = [];
    for (let i = start; i < newEnd; i++) {
      const text = newLineTexts[i]!;
      replacements.push({
        text,
        html: escapeHtml(text) + "\n",
        grammarState: undefined,
        grammarHash: "",
        dirty: true,
      });
    }

    lines.splice(start, oldEnd - start, ...replacements);
    value = newValue;
    renderViewport();
    scheduleTokenize(start);
  }

  // ── Events ─────────────────────────────────────────────────────────────────

  function onInput() {
    if (!textarea) return;
    applyEdit(textarea.value);
    onChange?.(textarea.value);
  }

  function onKeydown(e: KeyboardEvent) {
    if (!textarea) return;

    if (e.key === "Tab") {
      e.preventDefault();
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const tab = " ".repeat(tabSize);

      if (e.shiftKey) {
        // Dedent: remove leading spaces from selected lines
        const before = textarea.value.slice(0, start);
        const after = textarea.value.slice(end);
        const selected = textarea.value.slice(start, end);

        // Find the start of the first selected line
        const lineStart = before.lastIndexOf("\n") + 1;
        const prefix = textarea.value.slice(lineStart, start);
        const block = prefix + selected;
        const dedented = block.replace(new RegExp(`^( {1,${tabSize}})`, "gm"), "");
        const removed = block.length - dedented.length;

        const next = textarea.value.slice(0, lineStart) + dedented + after;
        textarea.value = next;

        // Adjust selection — the start may have shifted
        const prefixRemoved = prefix.length - dedented.split("\n")[0]!.length;
        textarea.selectionStart = Math.max(lineStart, start - prefixRemoved);
        textarea.selectionEnd = end - removed;

        applyEdit(next);
        onChange?.(next);
      } else {
        // Indent
        const next = textarea.value.slice(0, start) + tab + textarea.value.slice(end);
        textarea.value = next;
        textarea.selectionStart = textarea.selectionEnd = start + tabSize;
        applyEdit(next);
        onChange?.(next);
      }
    }
  }

  function onScroll() {
    if (!textarea) return;
    if (!mirror) return;
    if (!gutter) return;

    mirror.scrollTop = textarea.scrollTop;
    mirror.scrollLeft = textarea.scrollLeft;
    gutter.scrollTop = textarea.scrollTop;
  }

  function onGutterClick(e: MouseEvent) {
    if (!lineNumber) return;
    if (!textarea) return;
    if (!gutter) return;

    const rect = gutter.getBoundingClientRect();
    const paddingTop = 16; // matches 1rem padding in gutter style
    const clickY = e.clientY - rect.top + gutter.scrollTop - paddingTop;
    const lineIndex = Math.floor(clickY / lineHeight);

    if (lineIndex < 0 || lineIndex >= lines.length) return;

    // Calculate character positions for the line
    let lineStart = 0;
    for (let i = 0; i < lineIndex; i++) {
      lineStart += lines[i]!.text.length + 1; // +1 for newline
    }
    const lineEnd = lineStart + lines[lineIndex]!.text.length;

    // Select all characters in the line
    textarea.focus();
    textarea.selectionStart = lineStart;
    textarea.selectionEnd = lineEnd;

    // Re-render gutter to update relative line numbers if needed
    renderGutter();
  }

  textarea?.addEventListener("input", onInput);
  textarea?.addEventListener("keydown", onKeydown);
  textarea?.addEventListener("scroll", onScroll, { passive: true });
  textarea?.addEventListener("click", () => renderGutter());
  textarea?.addEventListener("keyup", () => renderGutter());

  if (lineNumber) {
    gutter?.addEventListener("click", onGutterClick);
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  function setValue(newValue: string) {
    if (!textarea) return;
    textarea.value = newValue;
    applyEdit(newValue);
  }

  function getValue(): string {
    return value;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    tokenizeAbortController.abort();

    // Remove event listeners to prevent leaks.
    textarea?.removeEventListener("input", onInput);
    textarea?.removeEventListener("keydown", onKeydown);
    textarea?.removeEventListener("scroll", onScroll);
    textarea?.removeEventListener("click", renderGutter);
    textarea?.removeEventListener("keyup", renderGutter);

    if (lineNumber) {
      gutter?.removeEventListener("click", onGutterClick);
    }

    container.innerHTML = "";
  }

  // ── Init ───────────────────────────────────────────────────────────────────

  setValue(value);

  return { setValue, getValue, dispose };
}
