import type { BundledLanguage, BundledTheme, HighlighterCore, ThemedToken } from "shiki";

declare const scheduler: { yield(): Promise<void> } | undefined;

// ─── Types ────────────────────────────────────────────────────────────────────

type GrammarState = NonNullable<ReturnType<HighlighterCore["codeToTokens"]>["grammarState"]>;

export interface LineRecord {
  text: string;
  html: string;
  grammarState: GrammarState | undefined;
  grammarHash: string;
  dirty: boolean;
}

export interface HoverInfo {
  start: number;
  length: number;
  text: string;
}

export interface ShikiEditorContext {
  getValue(): string;
  setValue(value: string): void;
  textarea: HTMLTextAreaElement | null;
  mirror: HTMLPreElement | null;
  gutter: HTMLDivElement | null;
  overlay: HTMLDivElement | null;
  container: HTMLElement;
}

export interface ShikiEditorPlugin {
  name: string;
  ready?(ctx: ShikiEditorContext): void | Promise<void>;
  dispose?(): void | Promise<void>;
  beforeChange?(
    newValue: string,
    oldValue: string,
  ): string | null | false | void | Promise<string | null | false | void>;
  change?(newValue: string, oldValue: string): void | Promise<void>;
  tokenizeLine?(
    lineIndex: number,
    tokens: ThemedToken[],
  ): ThemedToken[] | void | Promise<ThemedToken[] | void>;
  beforeRender?(lines: readonly LineRecord[]): void | Promise<void>;
  afterRender?(mirror: HTMLPreElement): void | Promise<void>;
  scroll?(scrollTop: number, scrollLeft: number): void | Promise<void>;
  keydown?(event: KeyboardEvent): boolean | void | Promise<boolean | void>;
  selectionChange?(start: number, end: number, cursorLine: number): void | Promise<void>;
  resolveHover?(
    offset: number,
    ctx: ShikiEditorContext,
  ): HoverInfo | null | undefined | Promise<HoverInfo | null | undefined>;
  showHover?(info: HoverInfo, rect: DOMRect, ctx: ShikiEditorContext): void | Promise<void>;
  hideHover?(ctx: ShikiEditorContext): void | Promise<void>;
}

export interface ShikiEditorOptions {
  shiki: HighlighterCore;
  lang: BundledLanguage;
  themes: Record<string, BundledTheme>;
  /** Default theme key. If not provided, uses the first theme key. */
  defaultTheme?: string;
  /** Whether to automatically detect and follow system dark mode preference. Default: true */
  followSystemTheme?: boolean;
  lineHeight?: number;
  tabSize?: number;
  onChange?: (value: string) => void;
  lineNumber?: "absolute" | "relative" | false;
  plugins?: ShikiEditorPlugin[];
}

export interface ShikiEditorHandle {
  setValue(value: string): void;
  getValue(): string;
  dispose(): void;
  use(plugin: ShikiEditorPlugin): Promise<void>;
}

// ─── Shell builder ────────────────────────────────────────────────────────────
//
// Replaces the pose element definitions with plain template functions.
// Returns an HTML string injected once via innerHTML — same pattern as before.

function buildShell(opts: {
  uid: string;
  gutterWidth: number;
  lineHeight: number;
  tabSize: number;
  lineNumber: "absolute" | "relative" | false;
}): string {
  const { uid, gutterWidth, lineHeight, tabSize, lineNumber } = opts;

  const noScrollbar = `
    <style>
      .${uid}-ns::-webkit-scrollbar { display: none; }
      .${uid}-ns { scrollbar-width: none; }
    </style>
  `.trim();

  const gutter = lineNumber !== false
    ? `<div
        id="shedit-gutter"
        style="width:${gutterWidth}px"
        class="absolute top-0 left-0 bottom-0 pt-4 pr-2 overflow-hidden box-border text-right
               font-[inherit] text-[inherit] leading-[inherit]
               opacity-50 select-none cursor-pointer [z-index:3] [contain:content]
               text-neutral-800 dark:text-neutral-200"
      ></div>`
    : `<div id="shedit-gutter" class="hidden"></div>`;

  const mirror = `
    <pre
      id="shedit-mirror"
      class="${uid}-ns absolute top-0 bottom-0 right-0
             m-0 p-4 border-0
             pointer-events-none select-none
             whitespace-pre-wrap break-words
             overflow-auto box-border
             font-[inherit] text-[inherit] leading-[inherit]
             [contain:strict] z-[0]"
      style="left:${gutterWidth}px"
    ></pre>
  `.trim();

  const overlay = `
    <div
      id="shedit-overlay"
      class="absolute top-0 bottom-0 right-0
             m-0 p-4
             pointer-events-none overflow-hidden
             box-border font-[inherit] text-[inherit] leading-[inherit]
             z-[1]"
      style="left:${gutterWidth}px"
    ></div>
  `.trim();

  const textarea = `
    <textarea
      id="shedit-textarea"
      spellcheck="false"
      autocomplete="off"
      autocorrect="off"
      autocapitalize="off"
      class="absolute top-0 bottom-0 right-0
             block m-0 p-4 h-full
             font-[inherit] text-[inherit] leading-[inherit]
             whitespace-pre-wrap break-words
             resize-none border-0 outline-none
             bg-transparent text-transparent caret-neutral-800 dark:caret-neutral-200
             box-border overflow-auto z-[2]"
      style="left:${gutterWidth}px;width:calc(100% - ${gutterWidth}px);tab-size:${tabSize}"
    ></textarea>
  `.trim();

  return `
    <div class="relative overflow-hidden w-full h-full font-[inherit] text-[inherit] leading-[inherit]">
      ${noScrollbar}
      ${gutter}
      ${mirror}
      ${overlay}
      ${textarea}
    </div>
  `.trim();
}

// ─── Utils ────────────────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeHtmlRuler(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/ /g, "&nbsp;")
    .replace(/\n/g, "<br>");
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

// ─── Ruler ────────────────────────────────────────────────────────────────────

let _ruler: HTMLDivElement | null = null;

function getRuler(): HTMLDivElement {
  if (_ruler) return _ruler;
  _ruler = document.createElement("div");
  _ruler.style.cssText = `
    position: fixed; visibility: hidden; pointer-events: none;
    top: 0; left: 0; white-space: pre-wrap; word-wrap: break-word;
    overflow: hidden; z-index: -9999;
  `;
  document.body.appendChild(_ruler);
  return _ruler;
}

function syncRulerStyles(ruler: HTMLDivElement, textarea: HTMLTextAreaElement) {
  const cs = getComputedStyle(textarea);
  ruler.style.width = textarea.clientWidth + "px";
  ruler.style.fontFamily = cs.fontFamily;
  ruler.style.fontSize = cs.fontSize;
  ruler.style.lineHeight = cs.lineHeight;
  ruler.style.letterSpacing = cs.letterSpacing;
  ruler.style.padding = cs.padding;
  ruler.style.tabSize = cs.tabSize;
  ruler.style.boxSizing = cs.boxSizing;
}

export function getCharacterRect(
  textarea: HTMLTextAreaElement,
  offset: number,
  length: number,
): DOMRect {
  const ruler = getRuler();
  syncRulerStyles(ruler, textarea);
  const text = textarea.value;
  ruler.innerHTML =
    escapeHtmlRuler(text.slice(0, offset)) +
    `<span id="__ruler_target__">${escapeHtmlRuler(text.slice(offset, offset + length)) || "\u200b"}</span>` +
    escapeHtmlRuler(text.slice(offset + length));
  const span = ruler.querySelector<HTMLSpanElement>("#__ruler_target__")!;
  const taRect = textarea.getBoundingClientRect();
  return new DOMRect(
    taRect.left + span.offsetLeft - textarea.scrollLeft,
    taRect.top + span.offsetTop - textarea.scrollTop,
    span.offsetWidth,
    span.offsetHeight,
  );
}

function mouseToOffset(textarea: HTMLTextAreaElement, clientX: number, clientY: number): number {
  const ruler = getRuler();
  syncRulerStyles(ruler, textarea);
  const text = textarea.value;
  const taRect = textarea.getBoundingClientRect();
  const rx = clientX - taRect.left + textarea.scrollLeft;
  const ry = clientY - taRect.top + textarea.scrollTop;
  const step = text.length > 3000 ? 8 : 1;
  let best = 0;
  let bestDist = Infinity;
  let bestDy = Infinity; // vertical distance

  function probe(i: number) {
    ruler.innerHTML =
      escapeHtmlRuler(text.slice(0, i)) +
      `<span id="__m2o__">\u200b</span>` +
      escapeHtmlRuler(text.slice(i));
    const span = ruler.querySelector<HTMLSpanElement>("#__m2o__");
    if (!span) return;
    const dx = rx - span.offsetLeft;
    const dy = ry - span.offsetTop;
    const dist = Math.hypot(dx, dy);
    if (dist < bestDist) {
      bestDist = dist;
      bestDy = Math.abs(dy);
      best = i;
    }
  }

  for (let i = 0; i <= text.length; i += step) probe(i);
  if (step > 1) {
    const lo = Math.max(0, best - step);
    const hi = Math.min(text.length, best + step);
    for (let i = lo; i <= hi; i++) probe(i);
  }

  // Return -1 if mouse is too far from any character
  // Use strict thresholds: must be close both horizontally and vertically
  const maxHorizontalDist = 40; // px - how far left/right from the token
  const maxVerticalDist = 15;   // px - how far up/down from the token's line

  // Recalculate bestDy for the final best position
  ruler.innerHTML =
    escapeHtmlRuler(text.slice(0, best)) +
    `<span id="__m2o__">\u200b</span>` +
    escapeHtmlRuler(text.slice(best));
  const finalSpan = ruler.querySelector<HTMLSpanElement>("#__m2o__");
  if (finalSpan) {
    const finalDy = Math.abs(ry - finalSpan.offsetTop);
    const finalDx = Math.abs(rx - finalSpan.offsetLeft);
    if (finalDy > maxVerticalDist || finalDx > maxHorizontalDist) return -1;
  }

  return best;
}

// ─── Waterfall runners ────────────────────────────────────────────────────────

async function runBeforeChange(
  plugins: ShikiEditorPlugin[],
  newValue: string,
  oldValue: string,
): Promise<string | null> {
  let current = newValue;
  for (const plugin of plugins) {
    if (!plugin.beforeChange) continue;
    const result = await plugin.beforeChange(current, oldValue);
    if (result === null || result === false) return null;
    if (typeof result === "string") current = result;
  }
  return current;
}

async function runTokenizeLine(
  plugins: ShikiEditorPlugin[],
  lineIndex: number,
  tokens: ThemedToken[],
): Promise<ThemedToken[]> {
  let current = tokens;
  for (const plugin of plugins) {
    if (!plugin.tokenizeLine) continue;
    const result = await plugin.tokenizeLine(lineIndex, current);
    if (Array.isArray(result)) current = result;
  }
  return current;
}

async function runKeydown(plugins: ShikiEditorPlugin[], event: KeyboardEvent): Promise<boolean> {
  for (const plugin of plugins) {
    if (!plugin.keydown) continue;
    const result = await plugin.keydown(event);
    if (result === true) return true;
  }
  return false;
}

async function runResolveHover(
  plugins: ShikiEditorPlugin[],
  offset: number,
  ctx: ShikiEditorContext,
): Promise<[ShikiEditorPlugin, HoverInfo] | null> {
  for (const plugin of plugins) {
    if (!plugin.resolveHover) continue;
    const result = await plugin.resolveHover(offset, ctx);
    if (result != null) return [plugin, result];
  }
  return null;
}

// ─── Diff ─────────────────────────────────────────────────────────────────────

function diffLines(oldLines: LineRecord[], newLines: string[]): [number, number, number] {
  const oldLen = oldLines.length;
  const newLen = newLines.length;
  let start = 0;
  while (start < oldLen && start < newLen && oldLines[start]!.text === newLines[start]) start++;
  let oldEnd = oldLen;
  let newEnd = newLen;
  while (
    oldEnd > start && newEnd > start &&
    oldLines[oldEnd - 1]!.text === newLines[newEnd - 1]
  ) { oldEnd--; newEnd--; }
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
    if (!style) { html += escaped; continue; }
    if (typeof style === "string") { html += `<span style="${style}">${escaped}</span>`; continue; }
    const styles: string[] = [];
    for (const theme in style) {
      const color = (style as Record<string, string>)[theme];
      if (!color) continue;
      if (theme === defaultTheme) styles.unshift(`color:${color}`);
      else styles.push(`--shiki-${theme}:${color}`);
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
    shiki, lang, themes,
    defaultTheme = Object.keys(themes)[0]!,
    followSystemTheme = true,
    lineHeight = 22,
    tabSize = 2,
    onChange,
    lineNumber = false,
    plugins: initialPlugins = [],
  } = options;

  let lines: LineRecord[] = [];
  let tokenizeAbortController = new AbortController();
  let value = "";
  let disposed = false;
  let lastCursorLine = -1;
  let scrollRafId = 0;
  let hoverRafId = 0;
  let lastHoverOffset = -1;
  let activeHoverPlugin: ShikiEditorPlugin | null = null;
  let currentTheme = defaultTheme;

  const plugins: ShikiEditorPlugin[] = [];

  // ── DOM shell ──────────────────────────────────────────────────────────────

  const uid = "shedit-" + Math.random().toString(36).slice(2, 8);
  const gutterWidth = lineNumber ? 48 : 0;

  container.style.cssText = `
    position: relative; overflow: hidden; width: 100%; height: 100%;
    font-family: ui-monospace, "JetBrains Mono", "Fira Code", monospace;
    font-size: 14px; line-height: ${lineHeight}px;
  `;

  container.innerHTML = buildShell({ uid, gutterWidth, lineHeight, tabSize, lineNumber });

  const mirror   = container.querySelector<HTMLPreElement>("#shedit-mirror")!;
  const overlay  = container.querySelector<HTMLDivElement>("#shedit-overlay")!;
  const textarea = container.querySelector<HTMLTextAreaElement>("#shedit-textarea")!;
  const gutter   = container.querySelector<HTMLDivElement>("#shedit-gutter")!;

  // ── Context ────────────────────────────────────────────────────────────────

  const ctx: ShikiEditorContext = {
    getValue: () => value,
    setValue: (v) => setValue(v),
    textarea, mirror, gutter, overlay, container,
  };

  // ── Plugin registration ────────────────────────────────────────────────────

  async function use(plugin: ShikiEditorPlugin): Promise<void> {
    if (plugins.some((p) => p.name === plugin.name)) {
      console.warn(`[shiki-editor] Plugin "${plugin.name}" is already registered.`);
      return;
    }
    plugins.push(plugin);
    if (plugin.ready) await plugin.ready(ctx);
  }

  // ── Gutter ─────────────────────────────────────────────────────────────────

  function getCursorLine(): number {
    return textarea.value.slice(0, textarea.selectionStart ?? 0).split("\n").length - 1;
  }

  function renderGutter() {
    if (!lineNumber) return;
    const cursorLine = getCursorLine();
    if (cursorLine === lastCursorLine && gutter.childElementCount === lines.length) return;
    lastCursorLine = cursorLine;
    let html = "";
    for (let i = 0; i < lines.length; i++) {
      const num = lineNumber === "absolute" ? i + 1 : Math.abs(i - cursorLine);
      html += `<div class="dark:text-neutral-200 text-neutral-800" style="height:${lineHeight}px;line-height:${lineHeight}px">${num}</div>`;
    }
    gutter.innerHTML = html;
    gutter.scrollTop = textarea.scrollTop;
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  function renderViewportWrapped() {
    for (const plugin of plugins) plugin.beforeRender?.(lines);
    let html = "";
    for (let i = 0; i < lines.length; i++) {
      html += `<span data-line="${i}" class="contents">${lines[i]!.html}</span>`;
    }
    mirror.innerHTML = html;
    mirror.scrollTop = textarea.scrollTop;
    mirror.scrollLeft = textarea.scrollLeft;
    renderGutter();
    for (const plugin of plugins) plugin.afterRender?.(mirror);
  }

  function patchMirrorLine(index: number, html: string): boolean {
    const node = mirror.querySelector(`[data-line="${index}"]`);
    if (!node) return false;
    node.innerHTML = html;
    return true;
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
          lang, themes, defaultColor: false,
          cssVariablePrefix: "", grammarState: prevState,
        });
      } catch { line.dirty = false; continue; }
      const tokens = await runTokenizeLine(plugins, i, result.tokens[0] ?? []);
      line.grammarState = result.grammarState;
      line.grammarHash = hashState(result.grammarState);
      line.html = tokensToHtml(tokens, themes, currentTheme);
      line.dirty = false;
      changed = true;
      if (i % 50 === 0 && changed) {
        renderViewportWrapped();
        changed = false;
        await yieldToMain();
      } else if (changed) {
        patchMirrorLine(i, line.html);
      }
    }
    if (!signal.aborted && changed) renderViewportWrapped();
  }

  function scheduleTokenize(fromLine: number) {
    tokenizeAbortController.abort();
    tokenizeAbortController = new AbortController();
    tokenizeFrom(fromLine, tokenizeAbortController.signal);
  }

  // ── Edit handling ──────────────────────────────────────────────────────────

  function commitEdit(newValue: string, oldValue: string) {
    const newLineTexts = newValue.split("\n");
    const [start, oldEnd, newEnd] = diffLines(lines, newLineTexts);
    const replacements: LineRecord[] = [];
    for (let i = start; i < newEnd; i++) {
      const text = newLineTexts[i]!;
      replacements.push({ text, html: escapeHtml(text) + "\n", grammarState: undefined, grammarHash: "", dirty: true });
    }
    lines.splice(start, oldEnd - start, ...replacements);
    value = newValue;
    if (replacements.length === 1 && oldEnd - start === 1) {
      const patched = patchMirrorLine(start, replacements[0]!.html);
      if (patched) {
        mirror.scrollTop = textarea.scrollTop;
        mirror.scrollLeft = textarea.scrollLeft;
        renderGutter();
        scheduleTokenize(start);
        for (const plugin of plugins) plugin.change?.(newValue, oldValue);
        return;
      }
    }
    renderViewportWrapped();
    scheduleTokenize(start);
    for (const plugin of plugins) plugin.change?.(newValue, oldValue);
  }

  async function applyEdit(newValue: string) {
    const oldValue = value;
    if (newValue === oldValue) return;
    const transformed = await runBeforeChange(plugins, newValue, oldValue);
    if (transformed === null) { textarea.value = oldValue; return; }
    if (transformed !== newValue) textarea.value = transformed;
    commitEdit(transformed, oldValue);
  }

  // ── Hover ──────────────────────────────────────────────────────────────────

  async function onMouseMove(e: MouseEvent) {
    if (hoverRafId) return;
    hoverRafId = requestAnimationFrame(async () => {
      hoverRafId = 0;
      const offset = mouseToOffset(textarea, e.clientX, e.clientY);
      // If mouse is too far from any character, hide hover and return
      if (offset === -1) {
        if (activeHoverPlugin) { activeHoverPlugin.hideHover?.(ctx); activeHoverPlugin = null; }
        lastHoverOffset = -1;
        return;
      }
      if (offset === lastHoverOffset) return;
      lastHoverOffset = offset;
      const match = await runResolveHover(plugins, offset, ctx);
      if (!match) {
        if (activeHoverPlugin) { activeHoverPlugin.hideHover?.(ctx); activeHoverPlugin = null; }
        return;
      }
      const [winningPlugin, info] = match;
      if (activeHoverPlugin && activeHoverPlugin !== winningPlugin) activeHoverPlugin.hideHover?.(ctx);
      activeHoverPlugin = winningPlugin;
      const rect = getCharacterRect(textarea, info.start, info.length);
      winningPlugin.showHover?.(info, rect, ctx);
    });
  }

  function onMouseLeave() {
    lastHoverOffset = -1;
    if (activeHoverPlugin) { activeHoverPlugin.hideHover?.(ctx); activeHoverPlugin = null; }
  }

  // ── Events ─────────────────────────────────────────────────────────────────

  function onInput() {
    applyEdit(textarea.value);
    onChange?.(textarea.value);
  }

  async function onKeydown(e: KeyboardEvent) {
    const handled = await runKeydown(plugins, e);
    if (handled) return;
    if (e.key === "Tab") {
      e.preventDefault();
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const tab = " ".repeat(tabSize);
      if (e.shiftKey) {
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
        const prefixRemoved = Math.max(0, prefix.length - dedented.split("\n")[0]!.length);
        textarea.selectionStart = Math.max(lineStart, start - prefixRemoved);
        textarea.selectionEnd = end - removed;
        await applyEdit(next);
        onChange?.(next);
      } else {
        const next = textarea.value.slice(0, start) + tab + textarea.value.slice(end);
        textarea.value = next;
        textarea.selectionStart = textarea.selectionEnd = start + tabSize;
        await applyEdit(next);
        onChange?.(next);
      }
    }
  }

  function onScroll() {
    if (scrollRafId) return;
    scrollRafId = requestAnimationFrame(() => {
      scrollRafId = 0;
      mirror.scrollTop = textarea.scrollTop;
      mirror.scrollLeft = textarea.scrollLeft;
      gutter.scrollTop = textarea.scrollTop;
      overlay.scrollTop = textarea.scrollTop;
      overlay.scrollLeft = textarea.scrollLeft;
      for (const plugin of plugins) plugin.scroll?.(textarea.scrollTop, textarea.scrollLeft);
    });
  }

  function onSelectionChange() {
    if (document.activeElement !== textarea) return;
    renderGutter();
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const cursorLine = getCursorLine();
    for (const plugin of plugins) plugin.selectionChange?.(start, end, cursorLine);
  }

  function onGutterClick(e: MouseEvent) {
    if (!lineNumber) return;
    const rect = gutter.getBoundingClientRect();
    const clickY = e.clientY - rect.top + gutter.scrollTop - 16;
    const lineIndex = Math.floor(clickY / lineHeight);
    if (lineIndex < 0 || lineIndex >= lines.length) return;
    let lineStart = 0;
    for (let i = 0; i < lineIndex; i++) lineStart += lines[i]!.text.length + 1;
    textarea.focus();
    textarea.selectionStart = lineStart;
    textarea.selectionEnd = lineStart + lines[lineIndex]!.text.length;
    renderGutter();
  }

  textarea.addEventListener("input", onInput);
  textarea.addEventListener("keydown", onKeydown);
  textarea.addEventListener("scroll", onScroll, { passive: true });
  textarea.addEventListener("mousemove", onMouseMove, { passive: true });
  textarea.addEventListener("mouseleave", onMouseLeave);
  document.addEventListener("selectionchange", onSelectionChange);
  if (lineNumber) gutter.addEventListener("click", onGutterClick);

  // ── Public API ─────────────────────────────────────────────────────────────

  function setValue(newValue: string) {
    textarea.value = newValue;
    commitEdit(newValue, value);
  }

  function getValue(): string { return value; }

  function dispose() {
    if (disposed) return;
    disposed = true;
    tokenizeAbortController.abort();
    if (scrollRafId) cancelAnimationFrame(scrollRafId);
    if (hoverRafId) cancelAnimationFrame(hoverRafId);
    textarea.removeEventListener("input", onInput);
    textarea.removeEventListener("keydown", onKeydown);
    textarea.removeEventListener("scroll", onScroll);
    textarea.removeEventListener("mousemove", onMouseMove);
    textarea.removeEventListener("mouseleave", onMouseLeave);
    document.removeEventListener("selectionchange", onSelectionChange);
    if (lineNumber) gutter.removeEventListener("click", onGutterClick);
    if (mediaQuery) mediaQuery.removeEventListener("change", onThemeChange);
    for (const plugin of plugins) plugin.dispose?.();
    container.innerHTML = "";
  }

  // ── Theme handling ─────────────────────────────────────────────────────────

  function getSystemTheme(): string {
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    return prefersDark && themes.dark ? "dark" : themes.light ? "light" : defaultTheme;
  }

  function applyTheme(theme: string) {
    currentTheme = theme;
    // Re-render with new theme
    scheduleTokenize(0);
  }

  function onThemeChange(e: MediaQueryListEvent) {
    if (!followSystemTheme) return;
    const newTheme = e.matches && themes.dark ? "dark" : themes.light ? "light" : defaultTheme;
    if (newTheme !== currentTheme) {
      applyTheme(newTheme);
    }
  }

  // Set up system theme detection
  const mediaQuery = followSystemTheme ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  if (mediaQuery) {
    mediaQuery.addEventListener("change", onThemeChange);
    // Apply initial system theme
    currentTheme = getSystemTheme();
  }

  // ── Init ───────────────────────────────────────────────────────────────────

  for (const plugin of initialPlugins) {
    plugins.push(plugin);
    if (plugin.ready) plugin.ready(ctx);
  }

  setValue(value);

  return { setValue, getValue, dispose, use };
}
