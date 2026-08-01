import katex from "katex";

export function renderMath(latex) {
  try {
    return katex.renderToString(latex, { displayMode: true, throwOnError: true, strict: "ignore", trust: false });
  } catch {
    return "";
  }
}
