import "../dist/editor.css";
import { createHighlighter } from "shiki";
import { createShikiEditor } from "../src";

async function main() {
  const shiki = await createHighlighter({
    langs: ["typescript", "rust"],
    themes: ["github-light", "github-dark"],
  });

  const editor = createShikiEditor(document.getElementById("editor")!, {
    shiki,
    lang: "typescript",
    themes: { light: "github-light", dark: "github-dark" },
    lineHeight: 22,
    tabSize: 2,
  });

  // Example: TypeScript
  editor.setValue(`function hello(name: string) {
  return \`Hello, \${name}!\`;
}

const greeting = hello("world");`);
}

main();
