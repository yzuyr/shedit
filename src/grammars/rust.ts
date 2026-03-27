import type { Tree, BaseNode } from "@sylphx/synth";
import type { Grammar, FunctionInfo, VariableInfo } from "../hover";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Get the text content of a node from its data bag */
function getNodeText(node: BaseNode): string | null {
  return ((node.data as Record<string, unknown>)?.text as string | null) ?? null;
}

/** Find a direct child of `parent` with the given type */
function findChild(tree: Tree, parent: BaseNode, type: string): BaseNode | null {
  return tree.nodes.find((n) => n.parent === parent.id && n.type === type) ?? null;
}

/** Find all direct children of `parent` with the given type */
function findChildren(tree: Tree, parent: BaseNode, type: string): BaseNode[] {
  return tree.nodes.filter((n) => n.parent === parent.id && n.type === type);
}

/** Find a direct child that is an identifier-like node */
function findIdentifierChild(tree: Tree, parent: BaseNode): BaseNode | null {
  return (
    tree.nodes.find(
      (n) => n.parent === parent.id && (n.type === "Identifier" || n.type === "identifier"),
    ) ?? null
  );
}

// ---------------------------------------------------------------------------
// Rust type resolution
// ---------------------------------------------------------------------------

function resolveRustType(tree: Tree, typeNode: BaseNode): string | null {
  switch (typeNode.type) {
    // Primitive types (tree-sitter maps these as PrimitiveType or TypeIdentifier)
    case "PrimitiveType":
    case "primitive_type":
      return getNodeText(typeNode);

    case "TypeIdentifier":
    case "type_identifier":
      return getNodeText(typeNode);

    // Reference types: &T, &mut T, &'a T
    case "ReferenceType":
    case "reference_type": {
      const mutable =
        findChild(tree, typeNode, "MutableSpecifier") ??
        findChild(tree, typeNode, "mutable_specifier");
      const inner = tree.nodes.find(
        (n) =>
          n.parent === typeNode.id &&
          n.type !== "MutableSpecifier" &&
          n.type !== "mutable_specifier" &&
          n.type !== "Lifetime" &&
          n.type !== "lifetime",
      );
      const innerStr = inner ? (resolveRustType(tree, inner) ?? "_") : "_";
      const lifetime =
        findChild(tree, typeNode, "Lifetime") ?? findChild(tree, typeNode, "lifetime");
      const lifetimeStr = lifetime ? getNodeText(lifetime) : null;

      let result = "&";
      if (lifetimeStr) result += `${lifetimeStr} `;
      if (mutable) result += "mut ";
      result += innerStr;
      return result;
    }

    // Generic types: Vec<T>, Option<T>, Result<T, E>
    case "GenericType":
    case "generic_type": {
      const name =
        findChild(tree, typeNode, "TypeIdentifier") ??
        findChild(tree, typeNode, "type_identifier") ??
        findChild(tree, typeNode, "ScopedTypeIdentifier") ??
        findChild(tree, typeNode, "scoped_type_identifier");
      const nameStr = name ? (resolveRustType(tree, name) ?? "_") : "_";

      const typeArgs =
        findChild(tree, typeNode, "TypeArguments") ?? findChild(tree, typeNode, "type_arguments");
      if (typeArgs) {
        const args = tree.nodes.filter((n) => n.parent === typeArgs.id);
        const argStrs = args.map((a) => resolveRustType(tree, a) ?? "_");
        return `${nameStr}<${argStrs.join(", ")}>`;
      }
      return nameStr;
    }

    // Scoped types: std::io::Result
    case "ScopedTypeIdentifier":
    case "scoped_type_identifier":
      return getNodeText(typeNode);

    // Array type: [T; N]
    case "ArrayType":
    case "array_type": {
      const inner = tree.nodes.find((n) => n.parent === typeNode.id);
      const innerStr = inner ? (resolveRustType(tree, inner) ?? "_") : "_";
      // Try to find the length expression
      return `[${innerStr}]`;
    }

    // Tuple type: (T, U, V)
    case "TupleType":
    case "tuple_type": {
      const elements = tree.nodes.filter((n) => n.parent === typeNode.id);
      const parts = elements.map((el) => resolveRustType(tree, el) ?? "_");
      return `(${parts.join(", ")})`;
    }

    // Slice type: [T]
    case "SliceType":
    case "slice_type": {
      const inner = tree.nodes.find((n) => n.parent === typeNode.id);
      const innerStr = inner ? (resolveRustType(tree, inner) ?? "_") : "_";
      return `[${innerStr}]`;
    }

    // Function pointer: fn(T) -> U
    case "FunctionType":
    case "function_type": {
      const params =
        findChild(tree, typeNode, "Parameters") ?? findChild(tree, typeNode, "parameters");
      const paramStr = params
        ? tree.nodes
            .filter((n) => n.parent === params.id)
            .map((p) => resolveRustType(tree, p) ?? "_")
            .join(", ")
        : "";
      const ret =
        findChild(tree, typeNode, "ReturnType") ?? findChild(tree, typeNode, "return_type");
      const retType = ret ? tree.nodes.find((n) => n.parent === ret.id) : null;
      const retStr = retType ? (resolveRustType(tree, retType) ?? "()") : "()";
      return `fn(${paramStr}) -> ${retStr}`;
    }

    // Unit type
    case "Unit":
    case "unit_type":
      return "()";

    // Never type
    case "NeverType":
    case "never_type":
      return "!";

    // Dynamic trait: dyn Trait
    case "DynamicType":
    case "dynamic_type": {
      const inner = tree.nodes.find((n) => n.parent === typeNode.id);
      const innerStr = inner ? (resolveRustType(tree, inner) ?? "_") : "_";
      return `dyn ${innerStr}`;
    }

    // Impl trait: impl Trait
    case "AbstractType":
    case "abstract_type": {
      const inner = tree.nodes.find((n) => n.parent === typeNode.id);
      const innerStr = inner ? (resolveRustType(tree, inner) ?? "_") : "_";
      return `impl ${innerStr}`;
    }

    default:
      // Fall back to source text for anything we don't handle
      return getNodeText(typeNode);
  }
}

function getRustTypeAnnotation(tree: Tree, node: BaseNode): string | null {
  // Rust type annotations appear as a child type node after ":"
  // In tree-sitter-rust, parameters have type as a direct child
  const typeNode = tree.nodes.find(
    (n) =>
      n.parent === node.id &&
      (n.type === "PrimitiveType" ||
        n.type === "primitive_type" ||
        n.type === "TypeIdentifier" ||
        n.type === "type_identifier" ||
        n.type === "ReferenceType" ||
        n.type === "reference_type" ||
        n.type === "GenericType" ||
        n.type === "generic_type" ||
        n.type === "ScopedTypeIdentifier" ||
        n.type === "scoped_type_identifier" ||
        n.type === "TupleType" ||
        n.type === "tuple_type" ||
        n.type === "ArrayType" ||
        n.type === "array_type" ||
        n.type === "SliceType" ||
        n.type === "slice_type" ||
        n.type === "FunctionType" ||
        n.type === "function_type" ||
        n.type === "Unit" ||
        n.type === "unit_type" ||
        n.type === "NeverType" ||
        n.type === "never_type" ||
        n.type === "DynamicType" ||
        n.type === "dynamic_type" ||
        n.type === "AbstractType" ||
        n.type === "abstract_type"),
  );
  if (!typeNode) return null;
  return resolveRustType(tree, typeNode);
}

function getRustReturnType(tree: Tree, funcNode: BaseNode): string | null {
  // tree-sitter-rust: return type is under a ReturnType / return_type child
  const retNode =
    findChild(tree, funcNode, "ReturnType") ?? findChild(tree, funcNode, "return_type");
  if (!retNode) return null;
  const typeNode = tree.nodes.find((n) => n.parent === retNode.id);
  if (!typeNode) return null;
  return resolveRustType(tree, typeNode);
}

// ---------------------------------------------------------------------------
// Node classification helpers
// ---------------------------------------------------------------------------

const RUST_IDENT_TYPES = new Set(["Identifier", "identifier"]);
const RUST_LITERAL_TYPES = new Set([
  "IntegerLiteral",
  "integer_literal",
  "FloatLiteral",
  "float_literal",
  "StringLiteral",
  "string_literal",
  "RawStringLiteral",
  "raw_string_literal",
  "CharLiteral",
  "char_literal",
  "BooleanLiteral",
  "boolean_literal",
  "ByteStringLiteral",
  "byte_string_literal",
]);
const RUST_FN_TYPES = new Set(["FunctionItem", "function_item"]);
const RUST_LET_TYPES = new Set(["LetDeclaration", "let_declaration"]);
const RUST_CLOSURE_TYPES = new Set(["ClosureExpression", "closure_expression"]);
const RUST_RETURN_TYPES = new Set(["ReturnExpression", "return_expression"]);

// ---------------------------------------------------------------------------
// Rust Grammar
// ---------------------------------------------------------------------------

export const rustGrammar: Grammar = {
  name: "rust",
  unknownType: "_",

  // ── Node classification ────────────────────────────────────────────

  isIdentifier: (node) => RUST_IDENT_TYPES.has(node.type),
  isLiteral: (node) => RUST_LITERAL_TYPES.has(node.type),
  isFunctionDeclaration: (node) => RUST_FN_TYPES.has(node.type),
  isVariableDeclaration: (node) => RUST_LET_TYPES.has(node.type),
  isFunctionExpression: (node) => RUST_CLOSURE_TYPES.has(node.type),
  isReturnStatement: (node) => RUST_RETURN_TYPES.has(node.type),

  // ── Node data extraction ───────────────────────────────────────────

  getIdentifierName: (node) => getNodeText(node),

  getLiteralValue(node) {
    const text = getNodeText(node);
    if (!text) return null;

    switch (node.type) {
      case "IntegerLiteral":
      case "integer_literal": {
        // Strip type suffix (e.g. 42u32 → 42)
        const cleaned = text.replace(/[iu](8|16|32|64|128|size)$/, "");
        return parseInt(cleaned, 10);
      }
      case "FloatLiteral":
      case "float_literal": {
        const cleaned = text.replace(/f(32|64)$/, "");
        return parseFloat(cleaned);
      }
      case "StringLiteral":
      case "string_literal":
        // Strip quotes
        return text.slice(1, -1);
      case "CharLiteral":
      case "char_literal":
        return text.slice(1, -1);
      case "BooleanLiteral":
      case "boolean_literal":
        return text === "true";
      default:
        return text;
    }
  },

  // ── Structural queries ─────────────────────────────────────────────

  getFunctionInfo(tree, node): FunctionInfo | null {
    // Function name
    const nameNode = findIdentifierChild(tree, node);
    const name = nameNode ? getNodeText(nameNode) : null;
    if (!name) return null;

    // Parameters: fn_item -> parameters -> parameter -> (pattern, type)
    const paramsNode = findChild(tree, node, "Parameters") ?? findChild(tree, node, "parameters");
    const params: FunctionInfo["params"] = [];

    if (paramsNode) {
      const paramChildren = findChildren(tree, paramsNode, "Parameter").concat(
        findChildren(tree, paramsNode, "parameter"),
      );

      for (const param of paramChildren) {
        const ident = findIdentifierChild(tree, param);
        const paramName = ident ? (getNodeText(ident) ?? "_") : "_";
        const paramType = getRustTypeAnnotation(tree, param) ?? "_";
        params.push({ name: paramName, type: paramType });
      }

      // Handle &self / &mut self / self
      const selfParams = findChildren(tree, paramsNode, "SelfParameter").concat(
        findChildren(tree, paramsNode, "self_parameter"),
      );
      for (const selfParam of selfParams) {
        const text = getNodeText(selfParam);
        params.unshift({ name: text ?? "self", type: "Self" });
      }
    }

    const returnType = getRustReturnType(tree, node);

    return { name, params, returnType, keyword: "fn" };
  },

  getVariableInfos(tree, node): VariableInfo[] {
    // let_declaration has: pattern, optional type, optional initializer
    const results: VariableInfo[] = [];

    // Check for `mut` keyword
    const mutableSpec =
      findChild(tree, node, "MutableSpecifier") ?? findChild(tree, node, "mutable_specifier");
    const kind = mutableSpec ? "let mut" : "let";
    const immutable = !mutableSpec;

    // Find the identifier (pattern)
    const idNode = findIdentifierChild(tree, node);
    if (!idNode) return results;

    const name = getNodeText(idNode);
    if (!name) return results;

    const type = getRustTypeAnnotation(tree, node);

    // Find initializer: the expression after "="
    // In tree-sitter-rust, the init is usually the last non-type, non-ident child
    const initNode =
      tree.nodes.find(
        (n) =>
          n.parent === node.id &&
          !RUST_IDENT_TYPES.has(n.type) &&
          n.type !== "MutableSpecifier" &&
          n.type !== "mutable_specifier" &&
          !isTypeNode(n),
      ) ?? null;

    results.push({ name, kind, type, immutable, initNode, idNode });
    return results;
  },

  getDeclaredIds(tree, node): BaseNode[] {
    const ids: BaseNode[] = [];

    if (RUST_LET_TYPES.has(node.type)) {
      const idNode = findIdentifierChild(tree, node);
      if (idNode) ids.push(idNode);
    }

    if (RUST_FN_TYPES.has(node.type)) {
      const nameNode = findIdentifierChild(tree, node);
      if (nameNode) ids.push(nameNode);
    }

    return ids;
  },

  getFunctionExpressionInfo(tree, node): FunctionInfo | null {
    if (!RUST_CLOSURE_TYPES.has(node.type)) return null;

    // Closure parameters: closure_expression -> closure_parameters -> parameter
    const paramsNode =
      findChild(tree, node, "ClosureParameters") ?? findChild(tree, node, "closure_parameters");
    const params: FunctionInfo["params"] = [];

    if (paramsNode) {
      const paramChildren = tree.nodes.filter(
        (n) => n.parent === paramsNode.id && RUST_IDENT_TYPES.has(n.type),
      );
      for (const p of paramChildren) {
        const paramName = getNodeText(p) ?? "_";
        // Closures may or may not have type annotations
        const paramType = getRustTypeAnnotation(tree, p) ?? "_";
        params.push({ name: paramName, type: paramType });
      }
    }

    const returnType = getRustReturnType(tree, node);

    return { name: "closure", params, returnType, keyword: "|closure|" };
  },

  getReturnArgument(tree, node): BaseNode | null {
    // In Rust, return_expression's child is the value
    return tree.nodes.find((n) => n.parent === node.id) ?? null;
  },

  // ── Type resolution ────────────────────────────────────────────────

  resolveTypeAnnotation: (tree, node) => getRustTypeAnnotation(tree, node),
  resolveTypeNode: (tree, typeNode) => resolveRustType(tree, typeNode),

  // ── Expression inference (Rust-specific) ───────────────────────────

  inferExpressionType(tree, node, symbols, _narrow): string | null {
    switch (node.type) {
      case "StringLiteral":
      case "string_literal":
        return "&str";

      case "RawStringLiteral":
      case "raw_string_literal":
        return "&str";

      case "ByteStringLiteral":
      case "byte_string_literal":
        return "&[u8]";

      case "IntegerLiteral":
      case "integer_literal": {
        const text = getNodeText(node);
        if (!text) return "i32";
        // Check for type suffix
        const suffixMatch = text.match(/(i8|i16|i32|i64|i128|isize|u8|u16|u32|u64|u128|usize)$/);
        return suffixMatch ? suffixMatch[1]! : "i32";
      }

      case "FloatLiteral":
      case "float_literal": {
        const text = getNodeText(node);
        if (!text) return "f64";
        const suffixMatch = text.match(/(f32|f64)$/);
        return suffixMatch ? suffixMatch[1]! : "f64";
      }

      case "BooleanLiteral":
      case "boolean_literal":
        return "bool";

      case "CharLiteral":
      case "char_literal":
        return "char";

      case "ArrayExpression":
      case "array_expression": {
        const elements = tree.nodes.filter((n) => n.parent === node.id);
        if (elements.length === 0) return "[]";
        const first = elements[0]!;
        const innerType = rustGrammar.inferExpressionType?.(tree, first, symbols, false) ?? "_";
        return `[${innerType}; ${elements.length}]`;
      }

      case "TupleExpression":
      case "tuple_expression": {
        const elements = tree.nodes.filter((n) => n.parent === node.id);
        const types = elements.map(
          (el) => rustGrammar.inferExpressionType?.(tree, el, symbols, false) ?? "_",
        );
        return `(${types.join(", ")})`;
      }

      case "StructExpression":
      case "struct_expression": {
        const name =
          findChild(tree, node, "TypeIdentifier") ??
          findChild(tree, node, "type_identifier") ??
          findChild(tree, node, "ScopedTypeIdentifier") ??
          findChild(tree, node, "scoped_type_identifier");
        return name ? (getNodeText(name) ?? "_") : "_";
      }

      case "CallExpression":
      case "call_expression": {
        const callee = findIdentifierChild(tree, node);
        if (callee) {
          const name = getNodeText(callee);
          if (name) {
            const sig = symbols.get(name);
            if (sig) {
              const arrowIdx = sig.lastIndexOf(" => ");
              if (arrowIdx !== -1) return sig.slice(arrowIdx + 4);
            }
          }
        }
        return "_";
      }

      case "MacroInvocation":
      case "macro_invocation": {
        // Common macros with known return types
        const macroName = findIdentifierChild(tree, node);
        const name = macroName ? getNodeText(macroName) : null;
        switch (name) {
          case "vec":
            return "Vec<_>";
          case "format":
          case "format_args":
            return "String";
          case "println":
          case "eprintln":
          case "print":
          case "eprint":
          case "dbg":
            return "()";
          case "todo":
          case "unimplemented":
          case "unreachable":
            return "!";
          case "panic":
            return "!";
          default:
            return "_";
        }
      }

      case "BlockExpression":
      case "block": {
        // The type of a block is the type of its last expression (if no semicolon)
        const children = tree.nodes.filter((n) => n.parent === node.id);
        const last = children[children.length - 1];
        if (last) {
          return rustGrammar.inferExpressionType?.(tree, last, symbols, false) ?? "_";
        }
        return "()";
      }

      case "IfExpression":
      case "if_expression": {
        // Try to infer from the consequent block
        const block = findChild(tree, node, "BlockExpression") ?? findChild(tree, node, "block");
        if (block) {
          return rustGrammar.inferExpressionType?.(tree, block, symbols, false) ?? "_";
        }
        return "_";
      }

      case "MatchExpression":
      case "match_expression":
        // Would need to unify all arm types — fall back
        return "_";

      default:
        return null;
    }
  },

  // ── Literal formatting ─────────────────────────────────────────────

  formatLiteralNarrow(node): string {
    const text = getNodeText(node);
    if (!text) return "_";

    switch (node.type) {
      case "IntegerLiteral":
      case "integer_literal":
      case "FloatLiteral":
      case "float_literal":
        return text;
      case "StringLiteral":
      case "string_literal":
        return `"${text.slice(1, -1)}"`;
      case "CharLiteral":
      case "char_literal":
        return `'${text.slice(1, -1)}'`;
      case "BooleanLiteral":
      case "boolean_literal":
        return text;
      default:
        return text;
    }
  },

  formatLiteralWidened(node): string {
    switch (node.type) {
      case "IntegerLiteral":
      case "integer_literal": {
        const text = getNodeText(node);
        if (text) {
          const suffixMatch = text.match(/(i8|i16|i32|i64|i128|isize|u8|u16|u32|u64|u128|usize)$/);
          if (suffixMatch) return suffixMatch[1]!;
        }
        return "i32";
      }
      case "FloatLiteral":
      case "float_literal": {
        const text = getNodeText(node);
        if (text) {
          const suffixMatch = text.match(/(f32|f64)$/);
          if (suffixMatch) return suffixMatch[1]!;
        }
        return "f64";
      }
      case "StringLiteral":
      case "string_literal":
      case "RawStringLiteral":
      case "raw_string_literal":
        return "&str";
      case "ByteStringLiteral":
      case "byte_string_literal":
        return "&[u8]";
      case "CharLiteral":
      case "char_literal":
        return "char";
      case "BooleanLiteral":
      case "boolean_literal":
        return "bool";
      default:
        return "_";
    }
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isTypeNode(node: BaseNode): boolean {
  const t = node.type;
  return (
    t === "PrimitiveType" ||
    t === "primitive_type" ||
    t === "TypeIdentifier" ||
    t === "type_identifier" ||
    t === "ReferenceType" ||
    t === "reference_type" ||
    t === "GenericType" ||
    t === "generic_type" ||
    t === "ScopedTypeIdentifier" ||
    t === "scoped_type_identifier" ||
    t === "TupleType" ||
    t === "tuple_type" ||
    t === "ArrayType" ||
    t === "array_type" ||
    t === "SliceType" ||
    t === "slice_type" ||
    t === "FunctionType" ||
    t === "function_type" ||
    t === "Unit" ||
    t === "unit_type" ||
    t === "NeverType" ||
    t === "never_type"
  );
}
