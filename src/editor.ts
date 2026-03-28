import type { BundledLanguage, BundledTheme, HighlighterCore, ThemedToken } from "shiki";

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
}

export interface ShikiEditorHandle {
  setValue(value: string): void;
  getValue(): string;
  dispose(): void;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const grammarHashCache = new WeakMap<object, string>();

function hashState(state: GrammarState | undefined): string {
  if (!state) return "";
  const cached = grammarHashCache.get(state);
  if (cached !== undefined) return cached;
  try {
    const scopes = state.getScopes();
    const hash = scopes ? JSON.stringify(scopes) : "";
    grammarHashCache.set(state, hash);
    return hash;
  } catch {
    return "";
  }
}

// Tokens → HTML.  Every color goes into a --shiki-{theme} CSS variable;
// the stylesheet picks the right one via `color: var(--shiki-light, inherit)`
// / dark-mode override.  No inline `color:` is set directly — that would
// fight the media-query approach in editor.css.
function tokensToHtml(tokens: ThemedToken[], themes: Record<string, BundledTheme>): string {
  if (!tokens.length) return "\n";
  let html = "";
  for (const token of tokens) {
    const escaped = escapeHtml(token.content);
    const style = token.htmlStyle;
    if (!style) {
      html += escaped;
      continue;
    }
    if (typeof style === "string") {
      html += `<span style="${style}">${escaped}</span>`;
      continue;
    }
    const parts: string[] = [];
    for (const theme in style) {
      const color = (style as Record<string, string>)[theme];
      if (color) parts.push(`--shiki-${theme}:${color}`);
    }
    html += parts.length ? `<span style="${parts.join(";")}">${escaped}</span>` : escaped;
  }
  return html + "\n";
}

function diffLines(oldLines: LineRecord[], newLines: string[]): [number, number, number] {
  const oldLen = oldLines.length;
  const newLen = newLines.length;
  let start = 0;
  while (start < oldLen && start < newLen && oldLines[start]!.text === newLines[start]) start++;
  let oldEnd = oldLen;
  let newEnd = newLen;
  while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1]!.text === newLines[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }
  return [start, oldEnd, newEnd];
}

// ─── Editor ───────────────────────────────────────────────────────────────────

export function createShikiEditor(
  container: HTMLElement,
  options: ShikiEditorOptions,
): ShikiEditorHandle {
  const { shiki, lang, themes, lineHeight = 22, tabSize = 2, onChange } = options;

  let lines: LineRecord[] = [];
  let value = "";
  let disposed = false;
  let tokenizeAbort = new AbortController();
  let scrollRaf = 0;
  let activeLine = -1;

  // ── DOM ───────────────────────────────────────────────────────────────────

  container.classList.add("sh-editor");
  container.style.setProperty("--sh-line-height", `${lineHeight}px`);
  container.style.setProperty("--sh-tab-size", String(tabSize));
  container.style.lineHeight = `${lineHeight}px`;

  container.innerHTML = `
    <div class="sh-gutter" aria-hidden="true"></div>
    <div class="sh-code-area">
      <pre class="sh-mirror"></pre>
      <textarea
        class="sh-textarea"
        spellcheck="false"
        autocomplete="off"
        autocorrect="off"
        autocapitalize="off"
      ></textarea>
    </div>
  `;

  const gutter = container.querySelector<HTMLDivElement>(".sh-gutter")!;
  const mirror = container.querySelector<HTMLPreElement>(".sh-mirror")!;
  const textarea = container.querySelector<HTMLTextAreaElement>(".sh-textarea")!;

  // ── Gutter ────────────────────────────────────────────────────────────────

  function renderGutter() {
    const count = lines.length || 1;
    const existing = gutter.children.length;

    // Add missing rows
    for (let i = existing; i < count; i++) {
      const span = document.createElement("span");
      span.className = "sh-gutter-line";
      span.textContent = String(i + 1);
      span.dataset.line = String(i);
      gutter.appendChild(span);
    }

    // Remove excess rows
    while (gutter.children.length > count) {
      gutter.lastElementChild!.remove();
    }

    // Only update text for rows whose number actually changed (e.g. after
    // lines were inserted/deleted in the middle — the tail shifts).
    // On pure appends/removals at the end, the loop body never executes.
    for (let i = existing > count ? 0 : Math.min(existing, count); i < count; i++) {
      const el = gutter.children[i] as HTMLElement;
      el.textContent = String(i + 1);
      el.dataset.line = String(i);
    }

    syncActiveGutterLine();
    gutter.scrollTop = textarea.scrollTop;
  }

  // ── Active line tracking ──────────────────────────────────────────────────

  function getCaretLine(): number {
    const pos = textarea.selectionStart;
    const text = textarea.value;
    let n = 0;
    for (let i = 0; i < pos; i++) {
      if (text.charCodeAt(i) === 10) n++;
    }
    return n;
  }

  function syncActiveGutterLine() {
    const prev = gutter.children[activeLine] as HTMLElement | undefined;
    const next = gutter.children[(activeLine = Math.max(0, activeLine))] as HTMLElement | undefined;
    // Fast path: unchanged
    if (prev === next && prev?.classList.contains("active")) return;
    if (prev) prev.classList.remove("active");
    next?.classList.add("active");
  }

  function updateActiveLine() {
    const line = getCaretLine();
    if (line === activeLine) return;
    const prevEl = gutter.children[activeLine] as HTMLElement | undefined;
    prevEl?.classList.remove("active");
    activeLine = line;
    const nextEl = gutter.children[activeLine] as HTMLElement | undefined;
    nextEl?.classList.add("active");
  }

  function selectLine(lineIndex: number) {
    if (lineIndex < 0 || lineIndex >= lines.length) return;
    let start = 0;
    for (let i = 0; i < lineIndex; i++) start += lines[i]!.text.length + 1;
    textarea.focus();
    textarea.setSelectionRange(start, start + lines[lineIndex]!.text.length);
    activeLine = lineIndex;
    syncActiveGutterLine();
  }

  function onGutterClick(e: MouseEvent) {
    const target = (e.target as HTMLElement).closest<HTMLElement>(".sh-gutter-line");
    if (!target) return;
    selectLine(Number(target.dataset.line));
  }

  gutter.addEventListener("click", onGutterClick);

  // ── Render ────────────────────────────────────────────────────────────────

  function renderMirror() {
    const parts: string[] = new Array(lines.length);
    for (let i = 0; i < lines.length; i++) {
      parts[i] = `<span data-line="${i}">${lines[i]!.html}</span>`;
    }
    mirror.innerHTML = parts.join("");
    mirror.scrollTop = textarea.scrollTop;
    mirror.scrollLeft = textarea.scrollLeft;
    renderGutter();
  }

  function patchMirrorLine(index: number, html: string): boolean {
    const node = mirror.querySelector<HTMLElement>(`[data-line="${index}"]`);
    if (!node) return false;
    node.innerHTML = html;
    return true;
  }

  // ── Tokenizer ─────────────────────────────────────────────────────────────

  async function tokenizeFrom(startLine: number, signal: AbortSignal) {
    let changed = false;
    let batchStart = performance.now();

    for (let i = startLine; i < lines.length; i++) {
      if (signal.aborted) return;
      const line = lines[i]!;
      const prevState = i > 0 ? lines[i - 1]?.grammarState : undefined;
      const prevHash = hashState(prevState);
      if (!line.dirty && line.grammarHash === prevHash) break;

      try {
        const result = shiki.codeToTokens(line.text, {
          lang,
          themes,
          defaultColor: false,
          cssVariablePrefix: "",
          grammarState: prevState,
        });
        line.grammarState = result.grammarState;
        line.grammarHash = hashState(result.grammarState);
        line.html = tokensToHtml(result.tokens[0] ?? [], themes);
      } catch {
        // leave as escaped plain text
      }
      line.dirty = false;
      changed = true;

      // Yield to keep UI responsive
      if (performance.now() - batchStart >= 8) {
        patchMirrorLine(i, line.html);
        await new Promise<void>((r) => setTimeout(r, 0));
        batchStart = performance.now();
      }
    }

    if (!signal.aborted && changed) renderMirror();
  }

  function scheduleTokenize(fromLine: number) {
    tokenizeAbort.abort();
    tokenizeAbort = new AbortController();
    tokenizeFrom(fromLine, tokenizeAbort.signal);
  }

  // ── Edit ──────────────────────────────────────────────────────────────────

  function commitEdit(newValue: string) {
    const newTexts = newValue.split("\n");
    const [start, oldEnd, newEnd] = diffLines(lines, newTexts);
    const replacements: LineRecord[] = [];
    for (let i = start; i < newEnd; i++) {
      const text = newTexts[i]!;
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

    // Fast path: single-line edit with unchanged line count → patch in place
    const linesChanged = newEnd - start;
    const linesRemoved = oldEnd - start;
    if (linesChanged === linesRemoved) {
      let allPatched = true;
      for (let i = start; i < newEnd; i++) {
        if (!patchMirrorLine(i, lines[i]!.html)) {
          allPatched = false;
          break;
        }
      }
      if (allPatched) {
        mirror.scrollTop = textarea.scrollTop;
        mirror.scrollLeft = textarea.scrollLeft;
        renderGutter();
        scheduleTokenize(start);
        return;
      }
    }

    // Slow path: line count changed → full rebuild
    renderMirror();
    scheduleTokenize(start);
  }

  // ── Events ────────────────────────────────────────────────────────────────

  function onInput() {
    commitEdit(textarea.value);
    onChange?.(textarea.value);
    updateActiveLine();
  }

  function onKeydown(e: KeyboardEvent) {
    // ── Enter: auto-indent ──────────────────────────────────────────────────
    if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const before = textarea.value.slice(0, start);
      const after = textarea.value.slice(end);

      // Copy leading whitespace from current line
      const lineStart = before.lastIndexOf("\n") + 1;
      const currentLine = before.slice(lineStart);
      const match = currentLine.match(/^[ \t]*/);
      const indent = match ? match[0] : "";

      const inserted = "\n" + indent;
      const next = before + inserted + after;
      textarea.value = next;
      textarea.selectionStart = textarea.selectionEnd = start + inserted.length;
      commitEdit(next);
      onChange?.(next);
      updateActiveLine();
      return;
    }

    // ── Tab / Shift+Tab ─────────────────────────────────────────────────────
    if (e.key !== "Tab") return;
    e.preventDefault();
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;

    if (e.shiftKey) {
      const before = textarea.value.slice(0, start);
      const after = textarea.value.slice(end);
      const selected = textarea.value.slice(start, end);
      const lineStart = before.lastIndexOf("\n") + 1;
      const prefix = textarea.value.slice(lineStart, start);
      const block = prefix + selected;
      const re = new RegExp(`^( {1,${tabSize}})`, "gm");
      const dedented = block.replace(re, "");
      const removed = block.length - dedented.length;
      const next = textarea.value.slice(0, lineStart) + dedented + after;
      textarea.value = next;
      const prefixRemoved = Math.max(0, prefix.length - dedented.split("\n")[0]!.length);
      textarea.selectionStart = Math.max(lineStart, start - prefixRemoved);
      textarea.selectionEnd = end - removed;
      commitEdit(next);
      onChange?.(next);
    } else {
      const tab = " ".repeat(tabSize);
      const next = textarea.value.slice(0, start) + tab + textarea.value.slice(end);
      textarea.value = next;
      textarea.selectionStart = textarea.selectionEnd = start + tabSize;
      commitEdit(next);
      onChange?.(next);
    }
  }

  function onScroll() {
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => {
      scrollRaf = 0;
      mirror.scrollTop = textarea.scrollTop;
      mirror.scrollLeft = textarea.scrollLeft;
      gutter.scrollTop = textarea.scrollTop;
    });
  }

  function onSelectionChange() {
    if (document.activeElement !== textarea) return;
    updateActiveLine();
  }

  textarea.addEventListener("input", onInput);
  textarea.addEventListener("keydown", onKeydown);
  textarea.addEventListener("scroll", onScroll, { passive: true });
  document.addEventListener("selectionchange", onSelectionChange);

  // ── Public API ────────────────────────────────────────────────────────────

  function setValue(newValue: string) {
    textarea.value = newValue;
    commitEdit(newValue);
  }

  function getValue(): string {
    return value;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    tokenizeAbort.abort();
    if (scrollRaf) cancelAnimationFrame(scrollRaf);
    textarea.removeEventListener("input", onInput);
    textarea.removeEventListener("keydown", onKeydown);
    textarea.removeEventListener("scroll", onScroll);
    gutter.removeEventListener("click", onGutterClick);
    document.removeEventListener("selectionchange", onSelectionChange);
    container.innerHTML = "";
  }

  // ── Init ──────────────────────────────────────────────────────────────────

  setValue(value);

  return { setValue, getValue, dispose };
}
