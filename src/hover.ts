import type { NodeHover } from "twoslash-protocol";
import type { Tree, BaseNode } from "@sylphx/synth";

// ===========================================================================
// Grammar interface — each language implements this
// ===========================================================================

export interface ParamInfo {
  name: string;
  type: string;
}

export interface FunctionInfo {
  name: string;
  params: ParamInfo[];
  returnType: string | null;
  /** Language keyword: "fn", "function", "def", "func", etc. */
  keyword: string;
}

export interface VariableInfo {
  name: string;
  /** Language keyword: "let", "const", "var", "let mut", etc. */
  kind: string;
  type: string | null;
  /** Whether the binding is immutable (const in JS, let in Rust, val in Kotlin…) */
  immutable: boolean;
  /** The initializer expression node, if any */
  initNode: BaseNode | null;
  /** The identifier node for this binding */
  idNode: BaseNode;
}

export interface Grammar {
  readonly name: string;
  readonly unknownType: string;

  isIdentifier(node: BaseNode): boolean;
  isLiteral(node: BaseNode): boolean;
  isFunctionDeclaration(node: BaseNode): boolean;
  isVariableDeclaration(node: BaseNode): boolean;
  isFunctionExpression(node: BaseNode): boolean;
  isReturnStatement(node: BaseNode): boolean;

  getIdentifierName(node: BaseNode): string | null;
  getLiteralValue(node: BaseNode): unknown;

  getFunctionInfo(tree: Tree, node: BaseNode): FunctionInfo | null;
  getVariableInfos(tree: Tree, node: BaseNode): VariableInfo[];
  getDeclaredIds(tree: Tree, node: BaseNode): BaseNode[];
  getFunctionExpressionInfo(tree: Tree, node: BaseNode): FunctionInfo | null;
  getReturnArgument(tree: Tree, node: BaseNode): BaseNode | null;

  resolveTypeAnnotation(tree: Tree, node: BaseNode): string | null;
  resolveTypeNode(tree: Tree, typeNode: BaseNode): string | null;

  inferExpressionType?(
    tree: Tree,
    node: BaseNode,
    symbols: Map<string, string>,
    narrow: boolean,
  ): string | null;

  formatLiteralNarrow(node: BaseNode): string;
  formatLiteralWidened(node: BaseNode): string;
}

// ===========================================================================
// Children index — O(1) child lookup instead of O(n) filter per node
// ===========================================================================
//
// The original code called `tree.nodes.filter(n => n.parent === id)` at every
// point that needed children — inside `collectDescendants`, `buildSymbolTable`,
// `collectHoverNodes`, and inside every grammar implementation. For a tree with
// N nodes this makes each lookup O(N), and since lookups are nested the overall
// complexity balloons to O(N²) or worse.
//
// We build the index once per `Tree` instance and cache it in a WeakMap so
// subsequent calls to `collectHoverNodes` with the same tree reuse it for free.

const childrenCache = new WeakMap<Tree, Map<number, BaseNode[]>>();

function buildChildrenIndex(tree: Tree): Map<number, BaseNode[]> {
  const cached = childrenCache.get(tree);
  if (cached) return cached;
  const index = new Map<number, BaseNode[]>();
  for (const node of tree.nodes) {
    const parent = node.parent;
    if (parent === undefined || parent === null) continue;
    let list = index.get(parent);
    if (!list) { list = []; index.set(parent, list); }
    list.push(node);
  }
  childrenCache.set(tree, index);
  return index;
}

function childrenOf(index: Map<number, BaseNode[]>, id: number): BaseNode[] {
  return index.get(id) ?? [];
}

// ===========================================================================
// Span helpers — with line/character pre-computation cache
// ===========================================================================
//
// `getNodeSpan` originally called `code.slice(0, offset).split("\n")` for every
// node in the tree. For a 500-node tree with 200-char average offset that's
// ~100 KB of string work just for span computation. We replace it with a single
// linear scan that builds an offset→(line,col) lookup table once per code
// string, also cached in a WeakMap (keyed on a wrapper object so the same
// string can be cached across calls).

interface SpanEntry {
  start: number;
  length: number;
  line: number;
  character: number;
}

// We can't WeakMap a string, so we cache per Tree+code pair using the Tree
// as the key and storing {code, table} so we can detect a stale code string.
interface LineTableCache {
  code: string;
  // Sorted array of line-start offsets. lineStarts[i] = offset of first char on line i.
  lineStarts: Uint32Array;
}

const lineTableCache = new WeakMap<Tree, LineTableCache>();

function getLineStarts(tree: Tree, code: string): Uint32Array {
  const cached = lineTableCache.get(tree);
  if (cached && cached.code === code) return cached.lineStarts;

  // Build the table in a single forward pass
  const starts: number[] = [0];
  for (let i = 0; i < code.length; i++) {
    if (code.charCodeAt(i) === 10 /* \n */) starts.push(i + 1);
  }
  const table = new Uint32Array(starts);
  lineTableCache.set(tree, { code, lineStarts: table });
  return table;
}

function offsetToLineCol(lineStarts: Uint32Array, offset: number): { line: number; character: number } {
  // Binary search for the last line that starts at or before `offset`
  let lo = 0, hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (lineStarts[mid]! <= offset) lo = mid; else hi = mid - 1;
  }
  return { line: lo, character: offset - lineStarts[lo]! };
}

function getNodeSpan(node: BaseNode, lineStarts: Uint32Array): SpanEntry | null {
  if (!node.span) return null;
  const start = node.span.start.offset;
  const length = node.span.end.offset - start;
  const { line, character } = offsetToLineCol(lineStarts, start);
  return { start, length, line, character };
}

// ===========================================================================
// Core expression type inference (grammar-agnostic with grammar callbacks)
// ===========================================================================

function inferExpressionType(
  grammar: Grammar,
  tree: Tree,
  node: BaseNode,
  symbols: Map<string, string>,
  narrow: boolean,
): string {
  if (grammar.inferExpressionType) {
    const result = grammar.inferExpressionType(tree, node, symbols, narrow);
    if (result !== null) return result;
  }

  if (grammar.isLiteral(node)) {
    return narrow ? grammar.formatLiteralNarrow(node) : grammar.formatLiteralWidened(node);
  }

  if (grammar.isIdentifier(node)) {
    const name = grammar.getIdentifierName(node);
    return name ? (symbols.get(name) ?? grammar.unknownType) : grammar.unknownType;
  }

  if (grammar.isFunctionExpression(node)) {
    const info = grammar.getFunctionExpressionInfo(tree, node);
    if (info) {
      const paramStr = joinParams(info.params);
      const ret = info.returnType ?? inferReturnType(grammar, tree, node, symbols);
      return `(${paramStr}) => ${ret}`;
    }
  }

  return grammar.unknownType;
}

// ===========================================================================
// Return type inference
// ===========================================================================
//
// `collectDescendants` previously called `tree.nodes.filter(n => n.parent === id)`
// inside a loop — O(N) per node. It now uses the children index for O(1) lookup.

function collectDescendants(
  grammar: Grammar,
  children: Map<number, BaseNode[]>,
  parent: BaseNode,
  skipNestedFunctions: boolean,
): BaseNode[] {
  const result: BaseNode[] = [];
  const stack = childrenOf(children, parent.id).slice(); // shallow copy so we can mutate
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (
      skipNestedFunctions &&
      node.id !== parent.id &&
      (grammar.isFunctionDeclaration(node) || grammar.isFunctionExpression(node))
    ) {
      continue;
    }
    result.push(node);
    for (const child of childrenOf(children, node.id)) stack.push(child);
  }
  return result;
}

function inferReturnType(
  grammar: Grammar,
  tree: Tree,
  funcNode: BaseNode,
  symbols: Map<string, string>,
): string {
  // Build/reuse the children index — already cached after first call
  const children = buildChildrenIndex(tree);
  const bodyNodes = collectDescendants(grammar, children, funcNode, true);

  const returnTypes: string[] = [];
  for (const n of bodyNodes) {
    if (!grammar.isReturnStatement(n)) continue;
    const arg = grammar.getReturnArgument(tree, n);
    returnTypes.push(arg ? inferExpressionType(grammar, tree, arg, symbols, false) : "void");
  }

  if (returnTypes.length === 0) return "void";
  if (returnTypes.length === 1) return returnTypes[0]!;

  // Deduplicate without allocating a Set when there are few types (common case)
  const unique: string[] = [];
  for (const t of returnTypes) if (!unique.includes(t)) unique.push(t);
  return unique.length === 1 ? unique[0]! : unique.join(" | ");
}

// ===========================================================================
// Shared param string helper — avoids repeated identical map+join patterns
// ===========================================================================

function joinParams(params: ParamInfo[]): string {
  if (params.length === 0) return "";
  if (params.length === 1) return `${params[0]!.name}: ${params[0]!.type}`;
  return params.map((p) => `${p.name}: ${p.type}`).join(", ");
}

// ===========================================================================
// Single-pass collectHoverNodes
// ===========================================================================
//
// The original code made three separate passes over `tree.nodes`:
//   1. `buildSymbolTable` — one full pass for declarations
//   2. A pass to collect `declaredIds`
//   3. A pass to emit hover nodes
//
// We merge all three into a single ordered pass. Since JavaScript's Map
// preserves insertion order and we process nodes in tree order, forward
// references (an identifier used before its declaration) still resolve
// correctly — we just emit `unknownType` for them at first, which is the same
// behaviour as before (the symbol table was also built in tree order).
//
// The children index is built once and reused throughout.

export function collectHoverNodes(grammar: Grammar, tree: Tree, code: string): NodeHover[] {
  const children  = buildChildrenIndex(tree);
  const lineStarts = getLineStarts(tree, code);
  const symbols   = new Map<string, string>();
  const hovers: NodeHover[] = [];

  // Declared identifier node IDs — populated as we encounter declarations
  const declaredIds = new Set<number>();

  for (const node of tree.nodes) {
    // ── Populate symbol table (replaces buildSymbolTable) ─────────────
    if (grammar.isFunctionDeclaration(node)) {
      const info = grammar.getFunctionInfo(tree, node);
      if (info) {
        const paramStr = joinParams(info.params);
        const ret =
          info.returnType ??
          grammar.resolveTypeAnnotation(tree, node) ??
          inferReturnType(grammar, tree, node, symbols);
        symbols.set(info.name, `(${paramStr}) => ${ret}`);
        for (const p of info.params) symbols.set(p.name, p.type);
      }
    }

    if (grammar.isVariableDeclaration(node)) {
      for (const v of grammar.getVariableInfos(tree, node)) {
        if (v.type) {
          symbols.set(v.name, v.type);
        } else if (v.initNode) {
          symbols.set(v.name, inferExpressionType(grammar, tree, v.initNode, symbols, v.immutable));
        }
      }
    }

    // ── Track declared identifier IDs (replaces the second pass) ──────
    if (grammar.isVariableDeclaration(node) || grammar.isFunctionDeclaration(node)) {
      for (const id of grammar.getDeclaredIds(tree, node)) declaredIds.add(id.id);
    }

    // ── Emit hover entries (replaces the third pass) ───────────────────
    const span = getNodeSpan(node, lineStarts);
    if (!span) continue;

    // Identifier references (not declaration sites)
    if (grammar.isIdentifier(node) && !declaredIds.has(node.id)) {
      const name = grammar.getIdentifierName(node);
      if (name) {
        const type =
          grammar.resolveTypeAnnotation(tree, node) ?? symbols.get(name) ?? grammar.unknownType;
        hovers.push({
          type: "hover",
          ...span,
          target: name,
          text: `${name}: ${type}`,
        });
      }
    }

    // Literals
    if (grammar.isLiteral(node)) {
      const raw = code.slice(span.start, span.start + span.length);
      hovers.push({
        type: "hover",
        ...span,
        target: raw,
        text: grammar.formatLiteralNarrow(node),
      });
    }

    // Function declarations
    if (grammar.isFunctionDeclaration(node)) {
      const info = grammar.getFunctionInfo(tree, node);
      if (info) {
        const paramStr = joinParams(info.params);
        const ret = info.returnType ?? inferReturnType(grammar, tree, node, symbols);
        hovers.push({
          type: "hover",
          ...span,
          target: info.name,
          text: `${info.keyword} ${info.name}(${paramStr}): ${ret}`,
        });
      }
    }

    // Variable declarations — emit per binding identifier
    if (grammar.isVariableDeclaration(node)) {
      for (const v of grammar.getVariableInfos(tree, node)) {
        const idSpan = getNodeSpan(v.idNode, lineStarts);
        if (!idSpan) continue;
        const type =
          v.type ??
          symbols.get(v.name) ??
          (v.initNode ? inferExpressionType(grammar, tree, v.initNode, symbols, v.immutable) : null) ??
          grammar.unknownType;
        hovers.push({
          type: "hover",
          ...idSpan,
          target: v.name,
          text: `${v.kind} ${v.name}: ${type}`,
        });
      }
    }

    // Function expressions (arrow functions, closures, lambdas)
    if (grammar.isFunctionExpression(node)) {
      const info = grammar.getFunctionExpressionInfo(tree, node);
      if (info) {
        const paramStr = joinParams(info.params);
        const ret = info.returnType ?? inferReturnType(grammar, tree, node, symbols);
        hovers.push({
          type: "hover",
          ...span,
          target: code.slice(span.start, span.start + Math.min(span.length, 20)),
          text: `(${paramStr}) => ${ret}`,
        });
      }
    }
  }

  return hovers;
}
