function escapeInline(value) {
  return String(value || "").replace(/([\\`*_[\]<>])/g, "\\$1");
}

function escapeLinkDestination(value) {
  return String(value || "").replace(/>/g, "%3E").replace(/\n/g, "");
}

function passageLinkRanges(passage) {
  const ranges = [];
  let offset = 0;
  for (const link of passage.links || []) {
    const start = passage.text.indexOf(link.label, offset);
    if (start < 0) continue;
    ranges.push({ start, end: start + link.label.length, href: link.href });
    offset = start + link.label.length;
  }
  return ranges;
}

function styledText(passage) {
  const text = String(passage.text || "");
  const links = passageLinkRanges(passage);
  const boundaries = new Set([0, text.length]);
  for (const ranges of [passage.boldRanges, passage.mathRanges, passage.superscriptRanges, passage.subscriptRanges]) {
    for (const range of ranges || []) {
      boundaries.add(Math.max(0, Math.min(text.length, range.start)));
      boundaries.add(Math.max(0, Math.min(text.length, range.end)));
    }
  }
  for (const link of links) { boundaries.add(link.start); boundaries.add(link.end); }
  const offsets = [...boundaries].sort((left, right) => left - right);
  let output = "";
  for (let index = 0; index < offsets.length - 1; index++) {
    const start = offsets[index];
    const end = offsets[index + 1];
    if (end <= start) continue;
    const raw = text.slice(start, end);
    const link = links.find((range) => range.start <= start && range.end >= end);
    if (link) {
      output += `[${escapeInline(raw)}](<${escapeLinkDestination(link.href)}>)`;
      continue;
    }
    const contains = (ranges) => (ranges || []).some((range) => range.start <= start && range.end >= end);
    let segment = escapeInline(raw);
    if (contains(passage.superscriptRanges)) segment = `<sup>${segment}</sup>`;
    else if (contains(passage.subscriptRanges)) segment = `<sub>${segment}</sub>`;
    else if (contains(passage.mathRanges)) segment = `$${raw.replace(/\$/g, "\\$")}$`;
    if (contains(passage.boldRanges)) segment = `**${segment}**`;
    output += segment;
  }
  if (passage.isBold) output = `**${output}**`;
  if (passage.isItalic) output = `*${output}*`;
  return output.trim();
}

function fencedCode(passage) {
  const text = String(passage.text || "").replace(/\s+$/u, "");
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence}${passage.language || ""}\n${text}\n${fence}`;
}

function markdownTable(table) {
  const rows = (table?.rows || []).map((row) => row.cells || []).filter((row) => row.length);
  if (!rows.length) return "";
  const columns = Math.max(...rows.map((row) => row.length));
  const cell = (value) => String(value || "").replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ").trim();
  const row = (cells) => `| ${Array.from({ length: columns }, (_, index) => cell(cells[index]?.text)).join(" | ")} |`;
  return [row(rows[0]), `| ${Array(columns).fill("---").join(" | ")} |`, ...rows.slice(1).map(row)].join("\n");
}

function markdownImage(passage) {
  const source = passage.image?.originalSrc || passage.image?.src;
  if (!source || source.startsWith("blob:")) return passage.description ? `*${escapeInline(passage.description)}*` : "";
  const alt = String(passage.image?.alt || passage.description || "Image").replace(/[\[\]]/g, "");
  return `![${alt}](<${escapeLinkDestination(source)}>)`;
}

function passageMarkdown(passage, formulaIsValid) {
  if (passage.type === "code") return fencedCode(passage);
  if (passage.type === "table") return markdownTable(passage.table);
  if (passage.type === "image") {
    const image = markdownImage(passage);
    const caption = passage.text && !/^Picture of\b/iu.test(passage.text) ? styledText(passage) : "";
    return [image, caption && `*${caption}*`].filter(Boolean).join("\n\n");
  }
  if (passage.type === "formula") {
    if (passage.latex && formulaIsValid(passage.latex)) return `$$\n${passage.latex}\n$$`;
    return markdownImage(passage);
  }
  const text = styledText(passage);
  if (!text) return "";
  if (passage.type === "heading") {
    const level = Math.max(2, Math.min(6, Number(passage.headingLevel) || 2));
    return `${"#".repeat(level)} ${text}`;
  }
  return text;
}

export function articleToMarkdown({ metadata = {}, sourceUrl = "", summary = "", passages = [], formulaIsValid = () => true } = {}) {
  const title = String(metadata.title || "Article").trim() || "Article";
  const output = [`# ${escapeInline(title)}`];
  const details = [metadata.author, metadata.site, metadata.published?.slice?.(0, 10)].filter(Boolean);
  if (details.length) output.push(`> ${details.map(escapeInline).join(" · ")}`);
  if (sourceUrl) output.push(`Source: [${escapeInline(sourceUrl)}](<${escapeLinkDestination(sourceUrl)}>)`);
  if (summary && !/^Could not summarize locally:/u.test(summary)) output.push(`## Local AI summary\n\n${escapeInline(summary)}`);

  let chatGroup = null;
  passages.forEach((passage, index) => {
    if (index === 0 && passage.type === "heading" && passage.text.trim() === title) return;
    if (passage.chatGroup !== undefined && passage.chatGroup !== chatGroup) {
      chatGroup = passage.chatGroup;
      output.push(`### ${escapeInline(passage.chatSpeaker || (passage.chatRole === "user" ? "You" : "Assistant"))}`);
    }
    const markdown = passageMarkdown(passage, formulaIsValid);
    if (markdown) output.push(markdown);
  });
  return `${output.join("\n\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}
