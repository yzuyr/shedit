export type { Grammar, ParamInfo, FunctionInfo, VariableInfo } from "./hover";

export { createShikiEditor } from "./editor";
export { collectHoverNodes } from "./hover";

// Grammars
import { typescriptGrammar } from "./grammars/typescript";
import { rustGrammar } from "./grammars/rust";

export const grammars = {
  typescript: typescriptGrammar,
  rust: rustGrammar,
};
