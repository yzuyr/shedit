import "../dist/editor.css";
import { createHighlighter } from "shiki";
import { createShikiEditor, collectHoverNodes, grammars } from "../src";
import { parse as parseTypeScript } from "@sylphx/synth-js";
import { twoslashHoverPlugin, type TwoslashData } from "../src/plugins/twoslash-hover";

// ---------------------------------------------------------------------------
// Twoslash adapters — one per language, all sharing the same hover engine
// ---------------------------------------------------------------------------

const tsToTwoslash = (code: string): TwoslashData => {
  const tree = parseTypeScript(code, { typescript: true });
  const nodes = collectHoverNodes(grammars.typescript, tree, code);
  return { code, nodes };
};

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const twoslashPlugin = twoslashHoverPlugin({
  data: {
    code: "",
    nodes: [],
  },
  slasher: tsToTwoslash,
});

async function main() {
  const shiki = await createHighlighter({
    langs: ["typescript", "rust"],
    themes: ["github-light", "github-dark"],
  });

  // Apply dark class to html element if system prefers dark mode
  // This enables Tailwind dark: variants for the entire page
  if (window.matchMedia("(prefers-color-scheme: dark)").matches) {
    document.documentElement.setAttribute("data-theme", "dark");
  }

  const editor = createShikiEditor(document.getElementById("editor")!, {
    shiki,
    lang: "typescript",
    themes: { light: "github-light", dark: "github-dark" },
    lineHeight: 22,
    tabSize: 2,
    lineNumber: "relative",
    plugins: [twoslashPlugin],
  });

  // Example: TypeScript
  editor.setValue(`function hello(name: string) {
  return \`Hello, \${name}!\`;
}

const greeting = hello("world");`);
}

main();
