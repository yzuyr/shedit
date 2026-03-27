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
  /** Human-readable language name */
  readonly name: string;

  /** The "unknown type" sentinel for this language (e.g. "any" for TS, "_" for Rust) */
  readonly unknownType: string;

  // ── Node classification ──────────────────────────────────────────────

  isIdentifier(node: BaseNode): boolean;
  isLiteral(node: BaseNode): boolean;
  isFunctionDeclaration(node: BaseNode): boolean;
  isVariableDeclaration(node: BaseNode): boolean;
  isFunctionExpression(node: BaseNode): boolean;
  isReturnStatement(node: BaseNode): boolean;

  // ── Node data extraction ─────────────────────────────────────────────

  getIdentifierName(node: BaseNode): string | null;
  getLiteralValue(node: BaseNode): unknown;

  // ── Structural queries ───────────────────────────────────────────────

  /** Extract function info (name, params, return type) from a function declaration node */
  getFunctionInfo(tree: Tree, node: BaseNode): FunctionInfo | null;

  /** Extract variable info from a variable declaration node. May return multiple for destructuring. */
  getVariableInfos(tree: Tree, node: BaseNode): VariableInfo[];

  /** Get the declared identifier nodes owned by a declaration (to avoid double-hover) */
  getDeclaredIds(tree: Tree, node: BaseNode): BaseNode[];

  /** Get function expression info (for arrow functions, closures, lambdas) */
  getFunctionExpressionInfo(tree: Tree, node: BaseNode): FunctionInfo | null;

  /** Get the return expression node from a return statement */
  getReturnArgument(tree: Tree, node: BaseNode): BaseNode | null;

  // ── Type resolution ──────────────────────────────────────────────────

  /** Resolve an explicit type annotation on a node, if present */
  resolveTypeAnnotation(tree: Tree, node: BaseNode): string | null;

  /** Resolve a type node to its string representation */
  resolveTypeNode(tree: Tree, typeNode: BaseNode): string | null;

  // ── Expression type inference ────────────────────────────────────────

  /**
   * Infer the type of an expression node. `narrow` controls whether
   * literal types are preserved (true for immutable bindings).
   *
   * This is optional — the engine provides a default implementation that
   * delegates to the grammar for language-specific cases.
   */
  inferExpressionType?(
    tree: Tree,
    node: BaseNode,
    symbols: Map<string, string>,
    narrow: boolean,
  ): string | null;

  // ── Literal type formatting ──────────────────────────────────────────

  /** Format a literal value as a narrow type string (e.g. `"hello"`, `5`, `true`) */
  formatLiteralNarrow(node: BaseNode): string;

  /** Format a literal value as a widened type string (e.g. `string`, `number`, `bool`) */
  formatLiteralWidened(node: BaseNode): string;
}

// ===========================================================================
// Span helpers (language-agnostic)
// ===========================================================================

function getNodeSpan(
  node: BaseNode,
  code: string,
): { start: number; length: number; line: number; character: number } | null {
  if (!node.span) return null;
  const lines = code.slice(0, node.span.start.offset).split("\n");
  const line = lines.length - 1;
  const lastLine = lines[lines.length - 1];
  if (lastLine === undefined) return null;
  const character = lastLine.length;
  return {
    start: node.span.start.offset,
    length: node.span.end.offset - node.span.start.offset,
    line,
    character,
  };
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
  // Let the grammar handle language-specific expressions first
  if (grammar.inferExpressionType) {
    const result = grammar.inferExpressionType(tree, node, symbols, narrow);
    if (result !== null) return result;
  }

  // Universal fallbacks
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
      const paramStr = info.params.map((p) => `${p.name}: ${p.type}`).join(", ");
      const ret = info.returnType ?? inferReturnType(grammar, tree, node, symbols);
      return `(${paramStr}) => ${ret}`;
    }
  }

  return grammar.unknownType;
}

// ===========================================================================
// Return type inference (grammar-agnostic)
// ===========================================================================

function collectDescendants(
  grammar: Grammar,
  tree: Tree,
  parent: BaseNode,
  skipNestedFunctions: boolean,
): BaseNode[] {
  const result: BaseNode[] = [];
  const childrenOf = (id: number) => tree.nodes.filter((n) => n.parent === id);

  const stack = childrenOf(parent.id);
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
    stack.push(...childrenOf(node.id));
  }

  return result;
}

function inferReturnType(
  grammar: Grammar,
  tree: Tree,
  funcNode: BaseNode,
  symbols: Map<string, string>,
): string {
  const bodyNodes = collectDescendants(grammar, tree, funcNode, true);
  const returnStatements = bodyNodes.filter((n) => grammar.isReturnStatement(n));

  if (returnStatements.length === 0) return "void";

  const returnTypes: string[] = [];

  for (const ret of returnStatements) {
    const arg = grammar.getReturnArgument(tree, ret);
    if (!arg) {
      returnTypes.push("void");
    } else {
      returnTypes.push(inferExpressionType(grammar, tree, arg, symbols, false));
    }
  }

  const unique = [...new Set(returnTypes)];
  if (unique.length === 0) return "void";
  if (unique.length === 1) return unique[0]!;
  return unique.join(" | ");
}

// ===========================================================================
// Symbol table (grammar-agnostic)
// ===========================================================================

function buildSymbolTable(grammar: Grammar, tree: Tree, code: string): Map<string, string> {
  const symbols = new Map<string, string>();

  for (const node of tree.nodes) {
    if (grammar.isFunctionDeclaration(node)) {
      const info = grammar.getFunctionInfo(tree, node);
      if (info) {
        // Store as callable signature for return type resolution on call sites
        const paramStr = info.params.map((p) => `${p.name}: ${p.type}`).join(", ");
        const ret =
          info.returnType ??
          grammar.resolveTypeAnnotation(tree, node) ??
          inferReturnType(grammar, tree, node, symbols);
        symbols.set(info.name, `(${paramStr}) => ${ret}`);

        // Register parameter names
        for (const p of info.params) {
          symbols.set(p.name, p.type);
        }
      }
    }

    if (grammar.isVariableDeclaration(node)) {
      const vars = grammar.getVariableInfos(tree, node);
      for (const v of vars) {
        // Explicit annotation wins
        if (v.type) {
          symbols.set(v.name, v.type);
          continue;
        }
        // Infer from initializer
        if (v.initNode) {
          symbols.set(v.name, inferExpressionType(grammar, tree, v.initNode, symbols, v.immutable));
        }
      }
    }
  }

  return symbols;
}

// ===========================================================================
// Hover collection (grammar-agnostic)
// ===========================================================================

export function collectHoverNodes(grammar: Grammar, tree: Tree, code: string): NodeHover[] {
  const hovers: NodeHover[] = [];
  const symbols = buildSymbolTable(grammar, tree, code);

  // Track declared identifiers to avoid double-emit
  const declaredIds = new Set<number>();

  for (const node of tree.nodes) {
    if (grammar.isVariableDeclaration(node) || grammar.isFunctionDeclaration(node)) {
      for (const id of grammar.getDeclaredIds(tree, node)) {
        declaredIds.add(id.id);
      }
    }
  }

  const seen = new Set<number>();

  for (const node of tree.nodes) {
    if (seen.has(node.id)) continue;
    seen.add(node.id);

    const span = getNodeSpan(node, code);
    if (!span) continue;

    // ── Identifier references (not declarations) ──────────────────────
    if (grammar.isIdentifier(node) && !declaredIds.has(node.id)) {
      const name = grammar.getIdentifierName(node);
      if (name) {
        const type =
          grammar.resolveTypeAnnotation(tree, node) ?? symbols.get(name) ?? grammar.unknownType;
        hovers.push({
          type: "hover",
          start: span.start,
          length: span.length,
          line: span.line,
          character: span.character,
          target: name,
          text: `${name}: ${type}`,
        });
      }
    }

    // ── Literals ──────────────────────────────────────────────────────
    if (grammar.isLiteral(node)) {
      const raw = code.slice(span.start, span.start + span.length);
      hovers.push({
        type: "hover",
        start: span.start,
        length: span.length,
        line: span.line,
        character: span.character,
        target: raw,
        text: grammar.formatLiteralNarrow(node),
      });
    }

    // ── Function declarations ─────────────────────────────────────────
    if (grammar.isFunctionDeclaration(node)) {
      const info = grammar.getFunctionInfo(tree, node);
      if (info) {
        const paramStr = info.params.map((p) => `${p.name}: ${p.type}`).join(", ");
        const ret = info.returnType ?? inferReturnType(grammar, tree, node, symbols);
        hovers.push({
          type: "hover",
          start: span.start,
          length: span.length,
          line: span.line,
          character: span.character,
          target: info.name,
          text: `${info.keyword} ${info.name}(${paramStr}): ${ret}`,
        });
      }
    }

    // ── Variable declarations ─────────────────────────────────────────
    if (grammar.isVariableDeclaration(node)) {
      const vars = grammar.getVariableInfos(tree, node);

      for (const v of vars) {
        const idSpan = getNodeSpan(v.idNode, code);
        if (!idSpan) continue;

        let type = v.type;
        if (!type) type = symbols.get(v.name) ?? null;
        if (!type && v.initNode) {
          type = inferExpressionType(grammar, tree, v.initNode, symbols, v.immutable);
        }
        if (!type) type = grammar.unknownType;

        hovers.push({
          type: "hover",
          start: idSpan.start,
          length: idSpan.length,
          line: idSpan.line,
          character: idSpan.character,
          target: v.name,
          text: `${v.kind} ${v.name}: ${type}`,
        });
      }
    }

    // ── Function expressions (arrow functions, closures, lambdas) ─────
    if (grammar.isFunctionExpression(node)) {
      const info = grammar.getFunctionExpressionInfo(tree, node);
      if (info) {
        const paramStr = info.params.map((p) => `${p.name}: ${p.type}`).join(", ");
        const ret = info.returnType ?? inferReturnType(grammar, tree, node, symbols);
        hovers.push({
          type: "hover",
          start: span.start,
          length: span.length,
          line: span.line,
          character: span.character,
          target: code.slice(span.start, span.start + Math.min(span.length, 20)),
          text: `(${paramStr}) => ${ret}`,
        });
      }
    }
  }

  return hovers;
}
