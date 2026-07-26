import katex from "katex";

export function renderMath(latex) {
  try {
    return katex.renderToString(latex, { displayMode: true, throwOnError: false, strict: "ignore", trust: false });
  } catch {
    return `<code>${escapeHtml(latex)}</code>`;
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}
