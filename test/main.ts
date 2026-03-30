import "../dist/editor.css";
import { createHighlighter } from "shiki";
import { createShikiEditor } from "../src";

const TS_CODE = `function hello(name: string) {
  return \`Hello, \${name}!\`;
}

const greeting = hello("world");`;

const RS_CODE = `fn hello(name: &str) -> String {
  format!("Hello, {}!", name)
}

let greeting = hello("world");`;

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

  editor.setValue(TS_CODE);

  document.querySelector("#lang-btn")?.addEventListener("click", () => {
    editor.setLang(editor.getLang() === "typescript" ? "rust" : "typescript");
    editor.setValue(editor.getLang() === "typescript" ? TS_CODE : RS_CODE);
  });
}

main();
