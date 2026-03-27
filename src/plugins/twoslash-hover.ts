import type { ShikiEditorPlugin, HoverInfo, ShikiEditorContext } from "../editor";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TwoslashNode {
  line: number;
  character: number;
  start: number;
  length: number;
  target: string;
  /** TypeScript hover text, e.g. "const greeting: string" */
  text: string;
  type: "hover" | "error" | "query" | string;
}

export interface TwoslashData {
  code: string;
  nodes: TwoslashNode[];
}

export type Slasher = (code: string) => TwoslashData | Promise<TwoslashData>;

export interface TwoslashPluginOptions {
  slasher: Slasher;
  /** Seed data for the very first render, before the slasher has run. */
  data?: TwoslashData;
  /** Debounce delay in ms before invoking the slasher after a change. Default: 250. */
  debounceMs?: number;
}

export interface TwoslashPluginHandle extends ShikiEditorPlugin {
  update(data: TwoslashData | null): void;
}

// ─── Hover node index ─────────────────────────────────────────────────────────
//
// We store sorted hover nodes in a flat typed array for compact memory and
// cache-friendly binary search, alongside a parallel string array for text.
// This avoids repeated object allocation on every index rebuild and makes
// `findNode` faster by keeping numeric fields together.

interface HoverIndex {
  // Parallel arrays — entry i spans [starts[i], starts[i] + lengths[i])
  starts: Int32Array;
  lengths: Int32Array;
  texts: string[];
  count: number;
}

const EMPTY_INDEX: HoverIndex = {
  starts: new Int32Array(0),
  lengths: new Int32Array(0),
  texts: [],
  count: 0,
};

function buildIndex(nodes: TwoslashNode[]): HoverIndex {
  const hover = nodes.filter((n) => n.type === "hover");
  if (hover.length === 0) return EMPTY_INDEX;

  hover.sort((a, b) => a.start - b.start);

  const count = hover.length;
  const starts = new Int32Array(count);
  const lengths = new Int32Array(count);
  const texts: string[] = new Array(count);

  for (let i = 0; i < count; i++) {
    starts[i] = hover[i]!.start;
    lengths[i] = hover[i]!.length;
    texts[i] = hover[i]!.text;
  }

  return { starts, lengths, texts, count };
}

// Binary search: find the last entry whose start ≤ offset, then verify
// containment. Walks back to handle overlapping spans (rare in practice).
function findInIndex(idx: HoverIndex, offset: number): HoverInfo | null {
  if (idx.count === 0) return null;

  const { starts, lengths, texts, count } = idx;
  let lo = 0,
    hi = count - 1,
    candidate = -1;

  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (starts[mid]! <= offset) {
      candidate = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }

  if (candidate === -1) return null;

  // Walk back over any overlapping spans
  for (let i = candidate; i >= 0; i--) {
    const s = starts[i]!;
    const end = s + lengths[i]!;
    if (end < offset) break; // sorted by start, so no earlier entry can contain offset
    if (s <= offset && offset < end) {
      return { start: s, length: lengths[i]!, text: texts[i]! };
    }
  }

  return null;
}

// ─── Debounce ─────────────────────────────────────────────────────────────────
//
// The original `change` hook fired the slasher on every keystroke with only a
// sequence counter to discard stale results. The slasher (a full TypeScript
// language-service run) is expensive — debouncing it prevents redundant work
// while keeping the UI responsive. The sequence guard is kept so that even if
// two debounced calls race (e.g. the user pauses, types again quickly), only
// the latest result is applied.

function makeDebounce(fn: (code: string) => void, ms: number) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  function debounced(code: string) {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(code);
    }, ms);
  }
  debounced.flush = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
  return debounced;
}

// ─── Tooltip ──────────────────────────────────────────────────────────────────
//
// Key changes vs. original:
//
// 1. `positionTooltip` now auto-flips the side when the preferred placement
//    would overflow the viewport, so the tooltip never clips off-screen.
//
// 2. `showTooltip` / `hideTooltip` toggle a single CSS class (`is-visible`)
//    instead of adding/removing three classes each time. This means only one
//    `classList` mutation per show/hide, and the transition is driven entirely
//    by CSS — matching the data-tooltip pattern more closely.
//
// 3. The tooltip element is created with a `<style>` tag injected once so the
//    Tailwind class list stays minimal and predictable regardless of purge
//    configuration.

const TOOLTIP_STYLE_ID = "shedit-twoslash-style";

function ensureTooltipStyle() {
  if (document.getElementById(TOOLTIP_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = TOOLTIP_STYLE_ID;
  // All transition state lives here — no runtime classList juggling beyond one toggle.
  style.textContent = `
    #shedit-twoslash-tooltip {
      position: fixed;
      z-index: 60;
      max-width: 20rem;
      width: fit-content;
      border-radius: 0.375rem;
      padding: 0.375rem 0.75rem;
      font-size: 0.875rem;
      line-height: 1.25rem;
      pointer-events: none;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      background: #171717; /* neutral-900 */
      color: #e5e5e5;      /* neutral-200 */
      visibility: hidden;
      opacity: 0;
      transform: scale(0.95);
      transition: opacity 150ms, transform 150ms, visibility 0s 150ms;
    }
    @media (prefers-color-scheme: dark) {
      #shedit-twoslash-tooltip {
        background: #f5f5f5; /* neutral-100 */
        color: #262626;      /* neutral-800 */
      }
    }
    #shedit-twoslash-tooltip.is-visible {
      visibility: visible;
      opacity: 1;
      transform: scale(1);
      transition: opacity 150ms, transform 150ms;
    }
  `.trim();
  document.head.appendChild(style);
}

function createTooltipElement(): HTMLDivElement {
  ensureTooltipStyle();
  const tooltip = document.createElement("div");
  tooltip.id = "shedit-twoslash-tooltip";
  return tooltip;
}

// Auto-flip: prefer `preferredSide`, flip to opposite if it would overflow.
function computeSide(
  tooltipRect: DOMRect,
  anchorRect: DOMRect,
  margin: number,
  preferredSide: "top" | "bottom",
): "top" | "bottom" {
  if (preferredSide === "top") {
    return anchorRect.top - tooltipRect.height - margin >= 0 ? "top" : "bottom";
  }
  return anchorRect.bottom + tooltipRect.height + margin <= window.innerHeight ? "bottom" : "top";
}

function positionTooltip(
  tooltip: HTMLDivElement,
  anchorRect: DOMRect,
  preferredSide: "top" | "bottom" = "top",
  align: "start" | "center" | "end" = "start",
) {
  // getBoundingClientRect() requires the element to be in the DOM and
  // non-hidden (visibility:hidden still contributes to layout — fine here).
  const tooltipRect = tooltip.getBoundingClientRect();
  const margin = 6;
  const padding = 8;

  const side = computeSide(tooltipRect, anchorRect, margin, preferredSide);
  const top =
    side === "top" ? anchorRect.top - tooltipRect.height - margin : anchorRect.bottom + margin;

  let left: number;
  switch (align) {
    case "start":
      left = anchorRect.left;
      break;
    case "end":
      left = anchorRect.right - tooltipRect.width;
      break;
    case "center":
      left = anchorRect.left + anchorRect.width / 2 - tooltipRect.width / 2;
      break;
  }

  tooltip.style.top = `${Math.max(padding, Math.min(top, window.innerHeight - tooltipRect.height - padding))}px`;
  tooltip.style.left = `${Math.max(padding, Math.min(left!, window.innerWidth - tooltipRect.width - padding))}px`;
}

function showTooltip(tooltip: HTMLDivElement) {
  tooltip.classList.add("is-visible");
}

function hideTooltip(tooltip: HTMLDivElement) {
  tooltip.classList.remove("is-visible");
}

// ─── Plugin factory ───────────────────────────────────────────────────────────

export function twoslashHoverPlugin(options: TwoslashPluginOptions): TwoslashPluginHandle {
  const { slasher, debounceMs = 250 } = options;

  let hoverIndex: HoverIndex = options.data ? buildIndex(options.data.nodes) : EMPTY_INDEX;
  let tooltipEl: HTMLDivElement | null = null;
  let showTimeoutId: ReturnType<typeof setTimeout> | null = null;
  let slasherSeq = 0;

  // ── Slasher runner ───────────────────────────────────────────────────────

  async function runSlasher(code: string): Promise<void> {
    const seq = ++slasherSeq;
    try {
      const result = await slasher(code);
      if (seq !== slasherSeq) return;
      hoverIndex = buildIndex(result.nodes);
    } catch (err) {
      if (seq === slasherSeq) console.error("[twoslash-hover] slasher error:", err);
    }
  }

  // Debounced wrapper — invalidates the current index immediately so stale
  // hovers don't linger while the new slasher run is in flight.
  const debouncedSlasher = makeDebounce((code: string) => {
    hoverIndex = EMPTY_INDEX; // clear stale data immediately
    runSlasher(code);
  }, debounceMs);

  // ── Tooltip helpers ──────────────────────────────────────────────────────

  function getTooltip(): HTMLDivElement {
    if (!tooltipEl) {
      tooltipEl = createTooltipElement();
      document.body.appendChild(tooltipEl);
    }
    return tooltipEl;
  }

  function clearShowTimeout() {
    if (showTimeoutId !== null) {
      clearTimeout(showTimeoutId);
      showTimeoutId = null;
    }
  }

  // ── Plugin object ────────────────────────────────────────────────────────

  return {
    name: "twoslash-hover",

    async ready(ctx) {
      const initial = ctx.getValue();
      if (initial) await runSlasher(initial);
    },

    change(newValue) {
      // Debounce: don't run the expensive slasher on every keystroke.
      debouncedSlasher(newValue);
    },

    dispose() {
      clearShowTimeout();
      debouncedSlasher.flush();
      tooltipEl?.remove();
      tooltipEl = null;
    },

    // Sync — no async overhead on the hot mouse-move path.
    resolveHover(offset) {
      return findInIndex(hoverIndex, offset);
    },

    showHover(info: HoverInfo, rect: DOMRect, _ctx: ShikiEditorContext) {
      clearShowTimeout();
      const tip = getTooltip();

      // Only update textContent when it actually changes to avoid unnecessary
      // layout invalidation on repeated hovers over the same token.
      if (tip.textContent !== info.text) tip.textContent = info.text;

      hideTooltip(tip);
      positionTooltip(tip, rect, "top", "start");

      showTimeoutId = setTimeout(() => {
        showTimeoutId = null;
        showTooltip(tip);
      }, 300);
    },

    hideHover() {
      clearShowTimeout();
      if (tooltipEl) hideTooltip(tooltipEl);
    },

    update(data: TwoslashData | null) {
      debouncedSlasher.flush();
      hoverIndex = data ? buildIndex(data.nodes) : EMPTY_INDEX;
    },
  };
}
