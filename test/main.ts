import { createHighlighter } from "shiki";
import { createShikiEditor } from "../src";

const shiki = await createHighlighter({
  langs: ["typescript"],
  themes: ["github-light", "github-dark"],
});

const editor = createShikiEditor(document.getElementById("editor")!, {
  shiki,
  lang: "typescript",
  themes: { light: "github-light", dark: "github-dark" },
  defaultTheme: "light",
  lineHeight: 22,
  tabSize: 2,
  onChange: (value) => console.log(value),
  lineNumber: "relative",
});

editor.setValue(`function hello(name: string) {\n  return \`Hello, \${name}!\`;\n}`);
