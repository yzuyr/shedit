import {
  isIdentifier,
  isLiteral,
  isFunctionDeclaration,
  isVariableDeclaration,
  getIdentifierName,
  getLiteralValue,
  getFunctionName,
  getVariableKind,
} from "@sylphx/synth-js";
import type { Tree, BaseNode } from "@sylphx/synth";
import type { Grammar, FunctionInfo, VariableInfo } from "../hover";

// ---------------------------------------------------------------------------
// Type annotation resolution (TS-specific)
// ---------------------------------------------------------------------------

function getTypeAnnotation(tree: Tree, node: BaseNode): string | null {
  const typeAnnotation = tree.nodes.find(
    (n) => n.parent === node.id && n.type === "TSTypeAnnotation",
  );
  if (!typeAnnotation) return null;

  const typeNode = tree.nodes.find((n) => n.parent === typeAnnotation.id);
  if (!typeNode) return null;

  return resolveTypeNodeTS(tree, typeNode);
}

function resolveTypeNodeTS(tree: Tree, typeNode: BaseNode): string | null {
  switch (typeNode.type) {
    case "TSStringKeyword":
      return "string";
    case "TSNumberKeyword":
      return "number";
    case "TSBooleanKeyword":
      return "boolean";
    case "TSAnyKeyword":
      return "any";
    case "TSUnknownKeyword":
      return "unknown";
    case "TSNeverKeyword":
      return "never";
    case "TSVoidKeyword":
      return "void";
    case "TSUndefinedKeyword":
      return "undefined";
    case "TSNullKeyword":
      return "null";
    case "TSObjectKeyword":
      return "object";
    case "TSSymbolKeyword":
      return "symbol";
    case "TSBigIntKeyword":
      return "bigint";

    case "TSArrayType": {
      const elementType = tree.nodes.find((n) => n.parent === typeNode.id);
      const inner = elementType ? resolveTypeNodeTS(tree, elementType) : "any";
      return `${inner}[]`;
    }

    case "TSTupleType": {
      const elements = tree.nodes.filter((n) => n.parent === typeNode.id);
      const parts = elements.map((el) => resolveTypeNodeTS(tree, el) ?? "any");
      return `[${parts.join(", ")}]`;
    }

    case "TSUnionType": {
      const members = tree.nodes.filter((n) => n.parent === typeNode.id);
      const parts = members.map((m) => resolveTypeNodeTS(tree, m) ?? "any");
      return parts.join(" | ");
    }

    case "TSIntersectionType": {
      const members = tree.nodes.filter((n) => n.parent === typeNode.id);
      const parts = members.map((m) => resolveTypeNodeTS(tree, m) ?? "any");
      return parts.join(" & ");
    }

    case "TSLiteralType": {
      const literal = tree.nodes.find((n) => n.parent === typeNode.id && isLiteral(n));
      if (literal) {
        const value = getLiteralValue(literal);
        if (typeof value === "string") return `"${value}"`;
        if (typeof value === "number") return `${value}`;
        if (typeof value === "boolean") return `${value}`;
      }
      return null;
    }

    case "TSFunctionType": {
      const params = tree.nodes.filter((n) => n.parent === typeNode.id && isIdentifier(n));
      const paramStrings = params.map((p) => {
        const name = getIdentifierName(p) ?? "_";
        const type = getTypeAnnotation(tree, p) ?? "any";
        return `${name}: ${type}`;
      });
      const returnAnnotation = getTypeAnnotation(tree, typeNode);
      return `(${paramStrings.join(", ")}) => ${returnAnnotation ?? "void"}`;
    }

    case "TSTypeReference": {
      const typeName = tree.nodes.find((n) => n.parent === typeNode.id && isIdentifier(n));
      const name = typeName ? (getIdentifierName(typeName) ?? "unknown") : "unknown";
      const typeParams = tree.nodes.find(
        (n) => n.parent === typeNode.id && n.type === "TSTypeParameterInstantiation",
      );
      if (typeParams) {
        const args = tree.nodes.filter((n) => n.parent === typeParams.id);
        const argStrings = args.map((a) => resolveTypeNodeTS(tree, a) ?? "any");
        return `${name}<${argStrings.join(", ")}>`;
      }
      return name;
    }

    case "TSTypeLiteral": {
      const members = tree.nodes.filter((n) => n.parent === typeNode.id);
      if (members.length === 0) return "{}";
      const parts = members
        .map((m) => {
          if (m.type !== "TSPropertySignature") return null;
          const key = tree.nodes.find((n) => n.parent === m.id && isIdentifier(n));
          if (!key) return null;
          const keyName = getIdentifierName(key) ?? "?";
          const type = getTypeAnnotation(tree, m) ?? "any";
          return `${keyName}: ${type}`;
        })
        .filter(Boolean);
      return `{ ${parts.join("; ")} }`;
    }

    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// TypeScript Grammar
// ---------------------------------------------------------------------------

export const typescriptGrammar: Grammar = {
  name: "typescript",
  unknownType: "any",

  // ── Node classification ────────────────────────────────────────────

  isIdentifier: (node) => isIdentifier(node),
  isLiteral: (node) => isLiteral(node),
  isFunctionDeclaration: (node) => isFunctionDeclaration(node),
  isVariableDeclaration: (node) => isVariableDeclaration(node),

  isFunctionExpression: (node) =>
    node.type === "ArrowFunctionExpression" || node.type === "FunctionExpression",

  isReturnStatement: (node) => node.type === "ReturnStatement",

  // ── Node data extraction ───────────────────────────────────────────

  getIdentifierName: (node) => getIdentifierName(node) ?? "",
  getLiteralValue: (node) => getLiteralValue(node),

  // ── Structural queries ─────────────────────────────────────────────

  getFunctionInfo(tree, node): FunctionInfo | null {
    const name = getFunctionName(node);
    if (!name) return null;

    const paramNodes = tree.nodes.filter((n) => n.parent === node.id && isIdentifier(n));
    const params = paramNodes.map((p) => ({
      name: getIdentifierName(p) ?? "_",
      type: getTypeAnnotation(tree, p) ?? "any",
    }));

    const returnType = getTypeAnnotation(tree, node);

    return { name, params, returnType, keyword: "function" };
  },

  getVariableInfos(tree, node): VariableInfo[] {
    const kind = getVariableKind(node) ?? "let";
    const immutable = kind === "const";
    const results: VariableInfo[] = [];

    const declarators = tree.nodes.filter(
      (n) => n.parent === node.id && n.type === "VariableDeclarator",
    );

    for (const declarator of declarators) {
      const idNode = tree.nodes.find((n) => n.parent === declarator.id && isIdentifier(n));
      if (!idNode) continue;

      const name = getIdentifierName(idNode);
      if (!name) continue;

      const type = getTypeAnnotation(tree, idNode);

      const initNode =
        tree.nodes.find((n) => n.parent === declarator.id && n.id !== idNode.id) ?? null;

      results.push({ name, kind, type, immutable, initNode, idNode });
    }

    return results;
  },

  getDeclaredIds(tree, node): BaseNode[] {
    const ids: BaseNode[] = [];

    if (isVariableDeclaration(node)) {
      const declarators = tree.nodes.filter(
        (n) => n.parent === node.id && n.type === "VariableDeclarator",
      );
      for (const d of declarators) {
        const idNode = tree.nodes.find((n) => n.parent === d.id && isIdentifier(n));
        if (idNode) ids.push(idNode);
      }
    }

    if (isFunctionDeclaration(node)) {
      const nameNode = tree.nodes.find((n) => n.parent === node.id && isIdentifier(n));
      if (nameNode) ids.push(nameNode);
    }

    return ids;
  },

  getFunctionExpressionInfo(tree, node): FunctionInfo | null {
    if (node.type !== "ArrowFunctionExpression" && node.type !== "FunctionExpression") {
      return null;
    }

    const paramNodes = tree.nodes.filter((n) => n.parent === node.id && isIdentifier(n));
    const params = paramNodes.map((p) => ({
      name: getIdentifierName(p) ?? "_",
      type: getTypeAnnotation(tree, p) ?? "any",
    }));

    const returnType = getTypeAnnotation(tree, node);

    return { name: "anonymous", params, returnType, keyword: "function" };
  },

  getReturnArgument(tree, node): BaseNode | null {
    return tree.nodes.find((n) => n.parent === node.id) ?? null;
  },

  // ── Type resolution ────────────────────────────────────────────────

  resolveTypeAnnotation: (tree, node) => getTypeAnnotation(tree, node),
  resolveTypeNode: (tree, typeNode) => resolveTypeNodeTS(tree, typeNode),

  // ── Expression inference (TS-specific cases) ───────────────────────

  inferExpressionType(tree, node, symbols, narrow): string | null {
    switch (node.type) {
      case "ArrayExpression": {
        const elements = tree.nodes.filter((n) => n.parent === node.id);
        if (elements.length === 0) return "never[]";
        const types = elements.map(
          (el) =>
            typescriptGrammar.inferExpressionType?.(tree, el, symbols, false) ??
            (isLiteral(el)
              ? narrow
                ? typescriptGrammar.formatLiteralNarrow(el)
                : typescriptGrammar.formatLiteralWidened(el)
              : "any"),
        );
        const unique = [...new Set(types)];
        return unique.length === 1 ? `${unique[0]}[]` : `(${unique.join(" | ")})[]`;
      }

      case "ObjectExpression": {
        const properties = tree.nodes.filter((n) => n.parent === node.id && n.type === "Property");
        if (properties.length === 0) return "{}";
        const parts = properties
          .map((prop) => {
            const key = tree.nodes.find((n) => n.parent === prop.id && isIdentifier(n));
            const value = tree.nodes.find((n) => n.parent === prop.id && !isIdentifier(n));
            if (!key || !value) return null;
            const keyName = getIdentifierName(key) ?? "?";
            const valueType =
              typescriptGrammar.inferExpressionType?.(tree, value, symbols, false) ?? "any";
            return `${keyName}: ${valueType}`;
          })
          .filter(Boolean);
        return `{ ${parts.join("; ")} }`;
      }

      case "TemplateLiteral":
        return "string";

      case "BinaryExpression":
        return "number";

      case "CallExpression": {
        const callee = tree.nodes.find((n) => n.parent === node.id && isIdentifier(n));
        if (callee) {
          const name = getIdentifierName(callee);
          if (name) {
            const sig = symbols.get(name);
            if (sig) {
              const arrowIdx = sig.lastIndexOf(" => ");
              if (arrowIdx !== -1) return sig.slice(arrowIdx + 4);
            }
          }
        }
        return "any";
      }

      case "NewExpression": {
        const callee = tree.nodes.find((n) => n.parent === node.id && isIdentifier(n));
        if (callee) {
          const name = getIdentifierName(callee);
          if (name) return name;
        }
        return "any";
      }

      case "ConditionalExpression": {
        const children = tree.nodes.filter((n) => n.parent === node.id);
        if (children.length >= 3) {
          const consequent =
            typescriptGrammar.inferExpressionType?.(tree, children[1]!, symbols, false) ?? "any";
          const alternate =
            typescriptGrammar.inferExpressionType?.(tree, children[2]!, symbols, false) ?? "any";
          if (consequent === alternate) return consequent;
          return `${consequent} | ${alternate}`;
        }
        return "any";
      }

      case "AwaitExpression": {
        const arg = tree.nodes.find((n) => n.parent === node.id);
        if (arg) {
          const inner = typescriptGrammar.inferExpressionType?.(tree, arg, symbols, false) ?? "any";
          const match = inner.match(/^Promise<(.+)>$/);
          if (match?.[1]) return match[1];
        }
        return "any";
      }

      case "AsExpression":
      case "TSAsExpression": {
        const typeAnnotation = tree.nodes.find(
          (n) => n.parent === node.id && n.type !== "Identifier" && !isLiteral(n),
        );
        if (typeAnnotation) {
          const resolved = resolveTypeNodeTS(tree, typeAnnotation);
          if (resolved) return resolved;
        }
        return "any";
      }

      default:
        // Return null to let the engine's universal fallback handle it
        return null;
    }
  },

  // ── Literal formatting ─────────────────────────────────────────────

  formatLiteralNarrow(node): string {
    const value = getLiteralValue(node);
    if (typeof value === "string") return `"${value}"`;
    if (typeof value === "number") return `${value}`;
    if (typeof value === "boolean") return `${value}`;
    if (value === null) return "null";
    if (value === undefined) return "undefined";
    return "any";
  },

  formatLiteralWidened(node): string {
    const value = getLiteralValue(node);
    if (typeof value === "string") return "string";
    if (typeof value === "number") return "number";
    if (typeof value === "boolean") return "boolean";
    if (value === null) return "null";
    if (value === undefined) return "undefined";
    return "any";
  },
};
