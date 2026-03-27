import type { ShikiEditorPlugin, HoverInfo, ShikiEditorContext } from "../editor";

// ─── Types ────────────────────────────────────────────────────────────────────

/** A single node from the twoslash output. */
export interface TwoslashNode {
  line: number;
  character: number;
  /** Absolute character offset from the start of the source string. */
  start: number;
  /** Length of the highlighted span in characters. */
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

/**
 * A function with the same signature as twoslash's generic function type.
 * Receives the current editor code and returns twoslash data.
 * May be sync or async.
 */
export type Slasher = (code: string) => TwoslashData | Promise<TwoslashData>;

export interface TwoslashPluginOptions {
  /**
   * The function used to produce twoslash data from source code.
   * Called automatically on every `change` hook and once during `ready`
   * with the editor's initial value.
   * If omitted, you must call `plugin.update(data)` manually.
   */
  slasher: Slasher;

  /**
   * Seed data used for the very first render, before the slasher has had a
   * chance to run. If `slasher` is provided this is overwritten immediately
   * in `ready()`, so you typically don't need to supply it.
   */
  data?: TwoslashData;
}

export interface TwoslashPluginHandle extends ShikiEditorPlugin {
  /** Directly replace the active dataset (bypasses the slasher). */
  update(data: TwoslashData | null): void;
}

// ─── Hover node index ─────────────────────────────────────────────────────────

function buildIndex(nodes: TwoslashNode[]): TwoslashNode[] {
  return nodes.filter((n) => n.type === "hover").sort((a, b) => a.start - b.start);
}

function findNode(index: TwoslashNode[], offset: number): TwoslashNode | null {
  // Binary search for last node with start <= offset
  let lo = 0,
    hi = index.length - 1,
    candidate = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (index[mid]!.start <= offset) {
      candidate = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (candidate === -1) return null;

  // Walk back to handle overlapping spans
  for (let i = candidate; i >= 0; i--) {
    const node = index[i]!;
    if (node.start + node.length < offset) break;
    if (node.start <= offset && offset < node.start + node.length) return node;
  }
  return null;
}

// ─── Tooltip element matching the CSS data-tooltip styling ────────────────────
//
// This creates a tooltip that looks identical to the CSS [data-tooltip]:before
// but can be positioned programmatically for code editor hover.

function createTooltipElement(): HTMLDivElement {
  const tooltip = document.createElement("div");
  tooltip.id = "shedit-twoslash-tooltip";

  // Use Tailwind colors:
  // bg-neutral-900 in light mode, bg-neutral-100 in dark mode
  // text-neutral-100 in light mode, text-neutral-900 in dark mode
  tooltip.className = `
    fixed z-[60] truncate max-w-xs w-fit rounded-md px-3 py-1.5 text-sm
    bg-neutral-900 text-neutral-200
    dark:bg-neutral-100 dark:text-neutral-800
    pointer-events-none
    invisible opacity-0 scale-95 transition-all duration-150
  `.replace(/\s+/g, " ").trim();

  return tooltip;
}

function positionTooltip(
  tooltip: HTMLDivElement,
  anchorRect: DOMRect,
  side: "top" | "bottom" | "left" | "right" = "top",
  align: "start" | "center" | "end" = "start"
) {
  const tooltipRect = tooltip.getBoundingClientRect();
  const margin = 6; // matches before:mb-1.5, before:mt-1.5 (1.5 * 4px = 6px)

  let top = 0;
  let left = 0;

  // Calculate position based on side (matching CSS logic)
  switch (side) {
    case "top":
      // @apply before:bottom-full before:mb-1.5 before:translate-y-2 hover:before:translate-y-0;
      top = anchorRect.top - tooltipRect.height - margin;
      break;
    case "bottom":
      // @apply before:top-full before:mt-1.5 before:-translate-y-2 hover:before:translate-y-0;
      top = anchorRect.bottom + margin;
      break;
    case "left":
      // @apply before:right-full before:mr-1.5 before:translate-x-2 hover:before:translate-x-0;
      left = anchorRect.left - tooltipRect.width - margin;
      break;
    case "right":
      // @apply before:left-full before:ml-1.5 before:-translate-x-2 hover:before:translate-x-0;
      left = anchorRect.right + margin;
      break;
  }

  // Calculate position based on alignment for top/bottom
  // CSS: &[data-align='start'] { @apply before:left-0; }
  // CSS: &[data-align='end'] { @apply before:right-0; }
  // CSS: &[data-align='center'] { @apply before:left-1/2 before:-translate-x-1/2; }
  if (side === "top" || side === "bottom") {
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
  }

  // Calculate position based on alignment for left/right
  // CSS: &[data-align='start'] { @apply before:top-0; }
  // CSS: &[data-align='end'] { @apply before:bottom-0; }
  // CSS: &[data-align='center'] { @apply before:top-1/2 before:-translate-y-1/2; }
  if (side === "left" || side === "right") {
    switch (align) {
      case "start":
        top = anchorRect.top;
        break;
      case "end":
        top = anchorRect.bottom - tooltipRect.height;
        break;
      case "center":
        top = anchorRect.top + anchorRect.height / 2 - tooltipRect.height / 2;
        break;
    }
  }

  // Keep within viewport
  const padding = 8;
  top = Math.max(padding, Math.min(top, window.innerHeight - tooltipRect.height - padding));
  left = Math.max(padding, Math.min(left, window.innerWidth - tooltipRect.width - padding));

  tooltip.style.top = `${top}px`;
  tooltip.style.left = `${left}px`;
}

function showTooltip(tooltip: HTMLDivElement) {
  // Match CSS hover state: @apply visible opacity-100 scale-100;
  tooltip.classList.remove("invisible", "opacity-0", "scale-95");
  tooltip.classList.add("visible", "opacity-100", "scale-100");
}

function hideTooltip(tooltip: HTMLDivElement) {
  // Match CSS non-hover state: @apply invisible opacity-0 scale-95;
  tooltip.classList.add("invisible", "opacity-0", "scale-95");
  tooltip.classList.remove("visible", "opacity-100", "scale-100");
}

// ─── Plugin factory ───────────────────────────────────────────────────────────

export function twoslashHoverPlugin(options: TwoslashPluginOptions): TwoslashPluginHandle {
  const { slasher } = options;

  let hoverIndex: TwoslashNode[] = options.data ? buildIndex(options.data.nodes) : [];
  let tooltipEl: HTMLDivElement | null = null;
  let showTimeoutId: ReturnType<typeof setTimeout> | null = null;
  // Guard against a slow slasher run overtaking a newer one
  let slasherSeq = 0;

  // ── Slasher runner ───────────────────────────────────────────────────────

  async function runSlasher(code: string): Promise<void> {
    if (!slasher) return;
    const seq = ++slasherSeq;
    try {
      const result = await slasher(code);
      // Discard if a newer run has already started
      if (seq !== slasherSeq) return;
      hoverIndex = buildIndex(result.nodes);
    } catch (err) {
      if (seq === slasherSeq) {
        console.error("[twoslash-hover] slasher error:", err);
      }
    }
  }

  // ── Tooltip helpers ──────────────────────────────────────────────────────

  function getTooltip(): HTMLDivElement {
    if (!tooltipEl) {
      tooltipEl = createTooltipElement();
      document.body.appendChild(tooltipEl);
    }
    return tooltipEl;
  }

  // ── Plugin object ────────────────────────────────────────────────────────

  return {
    name: "twoslash-hover",

    async ready(ctx) {
      // Run the slasher once with the editor's initial value so the first
      // render already has hover data — no manual wiring needed in the app.
      const initial = ctx.getValue();
      if (initial) await runSlasher(initial);
    },

    async change(newValue) {
      // Re-run on every edit. The seq guard ensures only the latest wins.
      await runSlasher(newValue);
    },

    dispose() {
      if (showTimeoutId) {
        clearTimeout(showTimeoutId);
        showTimeoutId = null;
      }
      tooltipEl?.remove();
      tooltipEl = null;
    },

    resolveHover(offset) {
      const node = findNode(hoverIndex, offset);
      if (!node) return null;
      return { start: node.start, length: node.length, text: node.text };
    },

    showHover(info: HoverInfo, rect: DOMRect, ctx: ShikiEditorContext) {
      // Clear any pending show timeout
      if (showTimeoutId) {
        clearTimeout(showTimeoutId);
        showTimeoutId = null;
      }

      const tip = getTooltip();
      tip.textContent = info.text;

      // Reset to hidden state for transition
      hideTooltip(tip);

      // Position the tooltip
      positionTooltip(tip, rect, "top", "start");

      // Delay showing the tooltip by 300ms
      showTimeoutId = setTimeout(() => {
        showTimeoutId = null;
        showTooltip(tip);
      }, 300);
    },

    hideHover() {
      // Clear any pending show timeout
      if (showTimeoutId) {
        clearTimeout(showTimeoutId);
        showTimeoutId = null;
      }
      if (tooltipEl) {
        hideTooltip(tooltipEl);
      }
    },

    // Public handle method — hot-swap data without the slasher
    update(data: TwoslashData | null) {
      hoverIndex = data ? buildIndex(data.nodes) : [];
    },
  };
}
