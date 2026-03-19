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
    return scopes ? JSON.stringify(scopes) : "";
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
  let lastCursorLine = -1;
  let scrollRafId = 0;

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
        contain: strict;
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
            contain: content;
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

  function getCursorLine(): number {
    if (!textarea) return 0;
    const cursorPos = textarea.selectionStart ?? 0;
    const textBeforeCursor = textarea.value.slice(0, cursorPos);
    return textBeforeCursor.split("\n").length - 1;
  }

  function getLineNumberHtml(lineIndex: number, cursorLine: number): string {
    if (!lineNumber) return "";

    let num: number;
    if (lineNumber === "absolute") {
      num = lineIndex + 1;
    } else {
      num = Math.abs(lineIndex - cursorLine);
    }
    return `<div style="height:${lineHeight}px;line-height:${lineHeight}px">${num}</div>`;
  }

  function renderGutter() {
    if (!lineNumber || !textarea || !gutter) return;

    const cursorLine = getCursorLine();

    // Skip rebuild when cursor line and line count haven't changed.
    if (cursorLine === lastCursorLine && gutter.childElementCount === lines.length) {
      return;
    }
    lastCursorLine = cursorLine;

    let html = "";
    for (let i = 0; i < lines.length; i++) {
      html += getLineNumberHtml(i, cursorLine);
    }
    gutter.innerHTML = html;
    gutter.scrollTop = textarea.scrollTop;
  }

  function renderViewport() {
    if (!textarea || !mirror) return;

    let html = "";
    for (let i = 0; i < lines.length; i++) {
      html += lines[i]!.html;
    }
    mirror.innerHTML = html;

    mirror.scrollTop = textarea.scrollTop;
    mirror.scrollLeft = textarea.scrollLeft;

    renderGutter();
  }

  /**
   * Surgically update a single line's DOM node in the mirror instead of
   * rebuilding the entire innerHTML. Returns true if the fast path succeeded.
   */
  function patchMirrorLine(index: number, html: string): boolean {
    if (!mirror) return false;
    // Mirror contains one text node per line (each line's html ends with \n).
    // After a full renderViewport the structure is a flat list of child nodes —
    // some are spans, some are raw text. However, because each line's html is
    // concatenated and set via innerHTML, the browser doesn't guarantee one
    // child node per line. We can only use this fast path when the mirror has
    // been built with wrapper elements.
    //
    // A more reliable approach: wrap each line in a <span data-line> during
    // render so we can address them individually.
    const lineNode = mirror.querySelector(`[data-line="${index}"]`);
    if (!lineNode) return false;
    lineNode.innerHTML = html;
    return true;
  }

  /** Full render with per-line wrapper spans for surgical updates. */
  function renderViewportWrapped() {
    if (!textarea || !mirror) return;

    let html = "";
    for (let i = 0; i < lines.length; i++) {
      html += `<span data-line="${i}" style="display:contents">${lines[i]!.html}</span>`;
    }
    mirror.innerHTML = html;

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

      // Try surgical update first; fall back to full render.
      if (i % 50 === 0 && changed) {
        renderViewportWrapped();
        changed = false;
        await yieldToMain();
      } else if (changed) {
        patchMirrorLine(i, line.html);
      }
    }

    if (!signal.aborted && changed) {
      renderViewportWrapped();
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

    // Single-line edit fast path: surgically update just the changed line
    // in the mirror DOM instead of a full innerHTML rebuild.
    if (replacements.length === 1 && oldEnd - start === 1 && mirror) {
      const patched = patchMirrorLine(start, replacements[0]!.html);
      if (patched) {
        // Sync scroll in case content height changed.
        mirror.scrollTop = textarea!.scrollTop;
        mirror.scrollLeft = textarea!.scrollLeft;
        renderGutter();
        scheduleTokenize(start);
        return;
      }
    }

    renderViewportWrapped();
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

        const lineStart = before.lastIndexOf("\n") + 1;
        const prefix = textarea.value.slice(lineStart, start);
        const block = prefix + selected;
        const dedented = block.replace(new RegExp(`^( {1,${tabSize}})`, "gm"), "");
        const removed = block.length - dedented.length;

        const next = textarea.value.slice(0, lineStart) + dedented + after;
        textarea.value = next;

        // Clamp prefixRemoved to avoid negative offsets.
        const prefixRemoved = Math.max(0, prefix.length - dedented.split("\n")[0]!.length);
        textarea.selectionStart = Math.max(lineStart, start - prefixRemoved);
        textarea.selectionEnd = end - removed;

        applyEdit(next);
        onChange?.(next);
      } else {
        const next = textarea.value.slice(0, start) + tab + textarea.value.slice(end);
        textarea.value = next;
        textarea.selectionStart = textarea.selectionEnd = start + tabSize;
        applyEdit(next);
        onChange?.(next);
      }
    }
  }

  function onScroll() {
    // Batch scroll sync into a single rAF to avoid layout thrashing.
    if (scrollRafId) return;
    scrollRafId = requestAnimationFrame(() => {
      scrollRafId = 0;
      if (!textarea || !mirror || !gutter) return;
      mirror.scrollTop = textarea.scrollTop;
      mirror.scrollLeft = textarea.scrollLeft;
      gutter.scrollTop = textarea.scrollTop;
    });
  }

  function onSelectionChange() {
    // Only react if our textarea is focused.
    if (document.activeElement !== textarea) return;
    renderGutter();
  }

  function onGutterClick(e: MouseEvent) {
    if (!lineNumber || !textarea || !gutter) return;

    const rect = gutter.getBoundingClientRect();
    const paddingTop = 16; // matches 1rem padding in gutter style
    const clickY = e.clientY - rect.top + gutter.scrollTop - paddingTop;
    const lineIndex = Math.floor(clickY / lineHeight);

    if (lineIndex < 0 || lineIndex >= lines.length) return;

    let lineStart = 0;
    for (let i = 0; i < lineIndex; i++) {
      lineStart += lines[i]!.text.length + 1;
    }
    const lineEnd = lineStart + lines[lineIndex]!.text.length;

    textarea.focus();
    textarea.selectionStart = lineStart;
    textarea.selectionEnd = lineEnd;

    renderGutter();
  }

  textarea?.addEventListener("input", onInput);
  textarea?.addEventListener("keydown", onKeydown);
  textarea?.addEventListener("scroll", onScroll, { passive: true });

  // Use selectionchange instead of separate click + keyup listeners.
  // This catches all selection changes: arrow keys, shift+arrows, mouse
  // drags, Cmd+A, triple-click, etc.
  document.addEventListener("selectionchange", onSelectionChange);

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

    if (scrollRafId) {
      cancelAnimationFrame(scrollRafId);
      scrollRafId = 0;
    }

    textarea?.removeEventListener("input", onInput);
    textarea?.removeEventListener("keydown", onKeydown);
    textarea?.removeEventListener("scroll", onScroll);
    document.removeEventListener("selectionchange", onSelectionChange);

    if (lineNumber) {
      gutter?.removeEventListener("click", onGutterClick);
    }

    container.innerHTML = "";
  }

  // ── Init ───────────────────────────────────────────────────────────────────

  setValue(value);

  return { setValue, getValue, dispose };
}
