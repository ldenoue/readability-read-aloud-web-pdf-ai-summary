import { InflectTTS } from "./inflect-tts.js";
import { PocketTTS } from "./pocket-tts.js";
import { marked } from "./dist/marked.esm.js";
import { renderMath } from "./dist/katex-render.js";
import { linkMatches } from "./dist/linkify.js";
import { embeddingTexts, getDocument, getDocumentByUrl, removeDocument, saveDocument, touchDocument, updateDocumentEmbeddings, updateDocumentSummary } from "./dist/library-store.js";
import { embedTexts } from "./embedding-client.js";

const $ = (selector) => document.querySelector(selector);
const state = { passages: [], index: 0, sentence: 0, run: 0, reading: false, language: "" };
const inflectTts = new InflectTTS({ model: "micro", onStatus: setStatus });
const pocketTts = new PocketTTS({ voice: "azelma", onStatus: setStatus });
const activeTts = () => $("#provider").value === "pocket" ? pocketTts : inflectTts;
let summaryLanguagePromise = null;
const SUMMARIZER_LANGUAGES = ["en", "fr", "de", "es", "ja"];
let summaryApiSupported = false;
let documentReady = false;
let summaryStarted = false;
let summaryPreference = "auto";
let activeDocumentId = "";
let activeSourceUrl = "";

function dataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error("Could not save PDF image."));
    reader.readAsDataURL(blob);
  });
}

async function serializablePassages(passages) {
  return Promise.all(passages.map(async (passage) => {
    const saved = structuredClone(passage);
    if (saved.image?.src?.startsWith("blob:")) {
      const response = await fetch(saved.image.src);
      saved.image.src = await dataUrl(await response.blob());
    }
    return saved;
  }));
}

async function persistDocument(input) {
  const saved = await saveDocument({ ...input, passages: await serializablePassages(input.passages) });
  activeDocumentId = saved.id;
  $("#deleteDocument").hidden = false;
  history.replaceState(null, "", `reader.html?doc=${encodeURIComponent(saved.id)}`);
  setTimeout(() => { void indexSavedDocument(saved); }, 500);
  return saved;
}

async function indexSavedDocument(saved) {
  if (saved.embeddingChunks?.length) return;
  try {
    const texts = embeddingTexts(saved);
    if (!texts.length) return;
    const vectors = await embedTexts(texts);
    await updateDocumentEmbeddings(saved.id, texts.map((text, index) => ({ text, vector: vectors[index] })));
  } catch (error) {
    console.warn("Local semantic indexing deferred:", error);
  }
}

function restoreSavedSummary(summary) {
  if (!summary?.text) return false;
  summaryStarted = true;
  $("#summaryPanel").hidden = false;
  $("#summaryLoading").hidden = true;
  $("#summarize").hidden = true;
  $("#summaryText").textContent = summary.text;
  $("#summaryText").hidden = false;
  return true;
}

async function setupSummarizer() {
  if (!("Summarizer" in globalThis)) {
    $("#summaryLoading").hidden = true;
    const button = $("#summarize");
    button.hidden = false;
    button.disabled = true;
    button.textContent = "Local AI summary unavailable";
    return;
  }
  summaryApiSupported = true;
  void maybeSummarizeAutomatically();
}

async function maybeSummarizeAutomatically() {
  if (!summaryApiSupported || !documentReady || summaryStarted || !state.passages.some((passage) => passage.text)) return;
  summaryLanguagePromise ||= detectSummaryLanguage();
  const language = await summaryLanguagePromise;
  if (!SUMMARIZER_LANGUAGES.includes(language)) {
    $("#summaryLoading").hidden = true;
    const button = $("#summarize");
    button.hidden = false;
    button.disabled = true;
    button.textContent = `${language.toUpperCase()} summaries unavailable`;
    return;
  }
  try {
    const preferences = language === "en" ? ["speed", "auto"] : ["auto"];
    let downloadablePreference = null;
    for (const preference of preferences) {
      const base = { type: "tldr", format: "plain-text", preference, expectedInputLanguages: [language], outputLanguage: language };
      const availability = await Promise.all([
        Summarizer.availability({ ...base, length: "long" }),
        Summarizer.availability({ ...base, length: "short" }),
      ]);
      if (availability.every((value) => value === "available")) {
        summaryPreference = preference;
        summaryStarted = true;
        $("#summaryPanel").hidden = false;
        $("#summaryLoading").hidden = false;
        void summarizeLocally();
        return;
      }
      if (!downloadablePreference && availability.every((value) => ["downloadable", "downloading", "available"].includes(value))) downloadablePreference = preference;
    }
    if (downloadablePreference) {
      summaryPreference = downloadablePreference;
      $("#summaryLoading").hidden = true;
      const button = $("#summarize");
      button.hidden = false;
      button.disabled = false;
      button.textContent = "Download & summarize locally";
    } else {
      $("#summaryLoading").hidden = true;
      const button = $("#summarize");
      button.hidden = false;
      button.disabled = true;
      button.textContent = "Local AI summary unavailable";
    }
  } catch (error) {
    console.warn("Automatic local summary unavailable:", error);
    $("#summaryLoading").hidden = true;
    const button = $("#summarize");
    button.hidden = false;
    button.disabled = true;
    button.textContent = "Local AI summary unavailable";
  }
}

async function detectSummaryLanguage() {
  const declared = state.language.toLowerCase().split(/[-_]/)[0];
  if (declared) return declared;
  const sample = summarySourceParts().join("\n").slice(0, 8000);
  if (!sample || !chrome.i18n?.detectLanguage) return "en";
  try {
    const result = await chrome.i18n.detectLanguage(sample);
    return result.languages?.sort((left, right) => right.percentage - left.percentage)[0]?.language?.split("-")[0] || "en";
  } catch {
    return "en";
  }
}

function summarySourceParts() {
  return state.passages.flatMap((passage) => {
    if (passage.text) return [passage.text];
    if (passage.type === "table") return passage.table.rows.map((row) => row.cells.map((cell) => cell.text).filter(Boolean).join(" | ")).filter(Boolean);
    return [];
  }).map((text) => textForSpeech(text).trim()).filter(Boolean);
}

async function createLocalSummarizer(length, onProgress, language, preference) {
  return Summarizer.create({
    type: "tldr",
    format: "plain-text",
    length,
    preference,
    expectedInputLanguages: [language],
    outputLanguage: language,
    monitor(monitor) {
      monitor.addEventListener("downloadprogress", (event) => onProgress?.(event.loaded));
    },
  });
}

async function splitForQuota(parts, summarizer, ratio = 0.78) {
  const limit = Math.max(1, Math.floor(summarizer.inputQuota * ratio));
  const chunks = [];
  let current = "";
  for (const part of parts) {
    const pieces = await splitOversizedPart(part, summarizer, limit);
    for (const piece of pieces) {
      const candidate = current ? `${current}\n\n${piece}` : piece;
      if (current && await summarizer.measureInputUsage(candidate) > limit) {
        chunks.push(current);
        current = piece;
      } else current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

async function splitOversizedPart(text, summarizer, limit) {
  if (await summarizer.measureInputUsage(text) <= limit) return [text];
  const units = sentences(text);
  if (units.length === 1) {
    const midpoint = Math.floor(text.length / 2);
    const split = text.lastIndexOf(" ", midpoint) > text.length * 0.25 ? text.lastIndexOf(" ", midpoint) : midpoint;
    return [...await splitOversizedPart(text.slice(0, split), summarizer, limit), ...await splitOversizedPart(text.slice(split).trim(), summarizer, limit)];
  }
  return splitForQuota(units, summarizer, 0.78);
}

async function summarizeLocally() {
  const parts = summarySourceParts();
  if (!parts.length) return;
  $("#summaryPanel").hidden = false;
  $("#summarize").hidden = true;
  $("#summaryText").hidden = true;
  $("#summaryLoading").hidden = false;
  let mapSummarizer;
  let finalSummarizer;
  try {
    const language = await (summaryLanguagePromise ||= detectSummaryLanguage());
    const downloadProgress = (loaded) => {
      const percent = Math.round(loaded * 100);
      if (loaded < 0.99) {
        setStatus({ state: "loading", message: `Downloading summarizer · ${percent}%` });
      } else {
        setStatus({ state: "loading", message: "Summarizing locally…" });
      }
    };
    mapSummarizer = await createLocalSummarizer("long", downloadProgress, language, summaryPreference);
    finalSummarizer = await createLocalSummarizer("short", downloadProgress, language, summaryPreference);
    let groups = await splitForQuota(parts, mapSummarizer);
    if (groups.length === 1 && await finalSummarizer.measureInputUsage(groups[0]) <= finalSummarizer.inputQuota * 0.78) {
      const summary = await finalSummarizer.summarize(groups[0]);
      $("#summaryText").textContent = summary;
    } else {
      let summaries = [];
      for (let index = 0; index < groups.length; index++) {
        setStatus({ state: "loading", message: `Summarizing section ${index + 1} of ${groups.length}…` });
        summaries.push(await mapSummarizer.summarize(groups[index], { context: "This is one section of a longer document." }));
      }
      let reductionRound = 0;
      while (await finalSummarizer.measureInputUsage(summaries.join("\n\n")) > finalSummarizer.inputQuota * 0.78) {
        if (++reductionRound > 6) throw new Error("The document could not be reduced to the local model's context window.");
        groups = await splitForQuota(summaries, mapSummarizer);
        const reduced = [];
        for (const group of groups) reduced.push(await mapSummarizer.summarize(group, { context: "Combine these partial document summaries without repetition." }));
        summaries = reduced;
      }
      setStatus({ state: "loading", message: "Finishing local summary…" });
      $("#summaryText").textContent = await finalSummarizer.summarize(summaries.join("\n\n"), { context: "Produce the final TLDR of this document." });
    }
    const summaryText = $("#summaryText").textContent;
    if (activeDocumentId && summaryText) {
      try {
        await updateDocumentSummary(activeDocumentId, { text: summaryText, language, createdAt: Date.now() });
      } catch (error) {
        console.warn("Could not persist local summary:", error);
      }
    }
    $("#summaryText").hidden = false;
    $("#summaryLoading").hidden = true;
    setStatus({ state: "ready", message: "Local AI summary ready" });
  } catch (error) {
    summaryStarted = false;
    $("#summaryLoading").hidden = true;
    $("#summaryText").hidden = false;
    $("#summaryText").textContent = `Could not summarize locally: ${error.message}`;
    const button = $("#summarize");
    button.hidden = false;
    button.disabled = false;
    button.textContent = "Try summary again";
    setStatus({ state: "error", message: error.message });
  } finally {
    mapSummarizer?.destroy();
    finalSummarizer?.destroy();
  }
}

function applyProviderUI() {
  const provider = $("#provider").value;
  $("#inflectModelField").hidden = provider !== "inflect";
  $("#pocketVoiceField").hidden = provider !== "pocket";
  $("#speedField").hidden = provider !== "inflect";
}

async function savePreferences() {
  await chrome.storage.local.set({
    readerPreferences: {
      provider: $("#provider").value,
      model: $("#model").value,
      voice: $("#voice").value,
      speed: $("#speed").value,
    },
  });
}

async function restorePreferences() {
  const { readerPreferences = {} } = await chrome.storage.local.get("readerPreferences");
  if (["pocket", "inflect"].includes(readerPreferences.provider)) $("#provider").value = readerPreferences.provider;
  if (InflectTTS.MODELS[readerPreferences.model]) $("#model").value = readerPreferences.model;
  if (PocketTTS.VOICES.includes(readerPreferences.voice)) $("#voice").value = readerPreferences.voice;
  if ([...$("#speed").options].some((option) => option.value === readerPreferences.speed)) $("#speed").value = readerPreferences.speed;
  inflectTts.setModel($("#model").value);
  pocketTts.setVoice($("#voice").value);
  applyProviderUI();
}

function setStatus({ state: statusState, message }) {
  $("#status").dataset.state = statusState;
  $("#status span").textContent = message;
}

function parseFrontMatter(markdown) {
  const match = markdown.match(/^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/);
  if (!match) return { metadata: {}, body: markdown };
  const metadata = {};
  for (const line of match[1].split("\n")) {
    const field = line.match(/^([\w-]+):\s*(.*)$/);
    if (!field) continue;
    metadata[field[1]] = field[2].trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return { metadata, body: markdown.slice(match[0].length) };
}

function removeEmbedBlocks(markdown) {
  const lines = markdown.split("\n");
  const kept = [];
  let linkedImage = false;
  let fencedCode = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) { fencedCode = !fencedCode; continue; }
    if (fencedCode) continue;
    if (!linkedImage && /^\s*\[!\[/.test(line)) {
      linkedImage = !/\]\(https?:\/\/[^\s]+\)\s*$/.test(line);
      continue;
    }
    if (linkedImage) {
      if (/\]\(https?:\/\/[^\s]+\)\s*$/.test(line)) linkedImage = false;
      continue;
    }
    if (/^\s*!\[.*\]\([^)]*\)\s*$/.test(line)) continue;
    kept.push(line);
  }
  return kept.join("\n");
}

function cleanInline(text) {
  let previous;
  let clean = text;
  do {
    previous = clean;
    clean = clean.replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  } while (clean !== previous);
  return clean
    .replace(/`[^`]*`/g, "")
    .replace(/<https?:\/\/[^>]+>/g, "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\[\^[^\]]+\]/g, "")
    .replace(/^\s*(?:[-*+] |\d+[.)] |>\s*)/, "")
    .replace(/[*_~#]/g, "")
    .replace(/\\([\[\]()`])/g, "$1")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function markdownPassages(markdown) {
  const cleaned = removeEmbedBlocks(markdown);
  const passages = [];
  let paragraph = [];
  const flush = () => {
    const text = cleanInline(paragraph.join(" "));
    if (text) passages.push({ type: "paragraph", text });
    paragraph = [];
  };
  for (const rawLine of cleaned.split("\n")) {
    const line = rawLine.trim();
    if (!line) { flush(); continue; }
    if (/^\[[^\]]+\]:\s*\S+/.test(line) || /^\|?\s*:?-{3}/.test(line)) continue;
    const heading = line.match(/^#{1,6}\s+(.+)$/);
    if (heading) { flush(); const text = cleanInline(heading[1]); if (text) passages.push({ type: "heading", text }); continue; }
    paragraph.push(line);
  }
  flush();
  return passages;
}

function htmlPassages(html, sourceUrl) {
  const document = new DOMParser().parseFromString(html, "text/html");
  document.querySelectorAll("script, style, noscript, pre, code, nav, form").forEach((element) => element.remove());
  const passages = [];
  for (const element of document.querySelectorAll("h1, h2, h3, h4, h5, h6, p, blockquote, li, img")) {
    if (element.matches("img")) {
      const rawSource = element.getAttribute("src") || element.getAttribute("data-src") || element.getAttribute("data-original");
      if (!rawSource || Number(element.getAttribute("width")) <= 2 || Number(element.getAttribute("height")) <= 2) continue;
      let src;
      try {
        const resolved = new URL(rawSource, sourceUrl);
        if (!["http:", "https:", "data:", "blob:"].includes(resolved.protocol)) continue;
        src = resolved.href;
      } catch { continue; }
      const description = (element.getAttribute("alt") || element.getAttribute("title") || "").replace(/\s+/g, " ").trim();
      passages.push({
        type: "image",
        text: description ? `Picture of ${description}` : "",
        description,
        image: { src, alt: description },
      });
      continue;
    }
    if (element.matches("li") && element.querySelector("p, blockquote")) continue;
    const text = element.textContent
      .replace(/https?:\/\/\S+/g, "")
      .replace(/\s+([,.;:!?])/g, "$1")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) continue;
    passages.push({ type: element.matches("h1, h2, h3, h4, h5, h6") ? "heading" : "paragraph", text });
  }
  return passages;
}

function pdfMarkdownPassages(markdown, sourceUrl) {
  const html = marked.parse(markdown, { gfm: true, breaks: false });
  return htmlPassages(html, sourceUrl).map((passage) => ({ ...passage, pdfText: passage.type !== "image" }));
}

function likelyPdfTitleBlock(pages, maxPages = 3) {
  const candidates = pages.flatMap((page) => (page.page <= maxPages ? (page.blocks || []).map((block) => ({ block, pageNumber: page.page })) : []))
    .filter(({ block }) => {
      const text = String(block.text || "").replace(/\s+/g, " ").trim();
      return block.type === "text"
        && block.isHorizontal !== false
        && !block.isPageNumber
        && !["Caption", "Footnote", "List-item"].includes(block.layoutLabel)
        && Number.isFinite(block.fontSize)
        && block.fontSize > 0
        && text.length >= 8
        && text.length <= 300;
    });
  return candidates.sort((left, right) => right.block.fontSize - left.block.fontSize
    || left.pageNumber - right.pageNumber
    || (left.block.layout?.y1 || 0) - (right.block.layout?.y1 || 0))[0]?.block || null;
}

function pdfTitleFromPages(pages) {
  const block = likelyPdfTitleBlock(pages);
  return block ? normalizePdfTypography(String(block.text || ""))
    .replace(/-\n(?=\p{Ll})/gu, "")
    .replace(/\s*\n\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim() : "";
}

function pdfBlockPassages(pages) {
  const sizedBlocks = pages.flatMap((page) => page.blocks || [])
    .filter((block) => block.type === "text" && block.fontSize > 0)
    .sort((left, right) => left.fontSize - right.fontSize);
  const bodyFontSize = sizedBlocks[Math.floor(sizedBlocks.length / 2)]?.fontSize || 11;
  const firstPage = pages.filter((page) => page.page === 1);
  const firstPageText = (firstPage[0]?.blocks || []).filter((block) => {
    const text = String(block.text || "").replace(/\s+/g, " ").trim();
    const pageHeight = block.layout?.pageHeight || 0;
    return block.type === "text"
      && !["Caption", "Footnote", "List-item"].includes(block.layoutLabel)
      && text.length >= 8
      && text.length <= 240
      && block.fontSize >= bodyFontSize * 1.3
      && (!pageHeight || block.layout?.y1 <= pageHeight * 0.4);
  });
  const likelyTitleBlock = firstPageText.find((block) => block.layoutLabel === "Title")
    || firstPageText.sort((left, right) => right.fontSize - left.fontSize || (left.layout?.y1 || 0) - (right.layout?.y1 || 0))[0];
  const passages = [];
  for (const page of pages) {
    for (const block of page.blocks || []) {
      if (block.isPageNumber) continue;
      if (block.type === "table" && block.table?.rows?.length) {
        const src = block.bytes ? URL.createObjectURL(new Blob([block.bytes], { type: block.mime || "image/png" })) : "";
        passages.push({ type: "table", text: "", table: block.table, image: src ? { src, alt: "Original PDF table" } : null, page: page.page, layout: block.layout });
        continue;
      }
      if (block.type === "image" && block.bytes) {
        const src = URL.createObjectURL(new Blob([block.bytes], { type: block.mime || "image/png" }));
        passages.push({ type: block.latex ? "formula" : "image", text: "", latex: block.latex || "", image: { src, alt: block.label || "PDF visual", width: block.width, height: block.height }, page: page.page, layout: block.layout });
        continue;
      }
      const markedText = normalizePdfTypography(String(block.text || ""))
        .replace(/-\n(?=\p{Ll})/gu, "")
        .replace(/\s*\n\s*/g, " ")
        .replace(/\s+([,.;:!?%)\]])/g, "$1")
        .replace(/\s+/g, " ")
        .trim();
      const { text, superscriptRanges } = extractPdfSuperscripts(markedText);
      if (!text) continue;
      const fontRatio = (block.fontSize || bodyFontSize) / bodyFontSize;
      const isTitle = block === likelyTitleBlock;
      const isHeading = isTitle || ["Title", "Section-header"].includes(block.layoutLabel)
        || (block.layoutLabel === "Text" && fontRatio >= 1.45 && text.length <= 180 && !/[.!?]$/u.test(text));
      passages.push({
        type: isHeading ? "heading" : "paragraph",
        text,
        superscriptRanges,
        pdfText: true,
        headingLevel: isTitle ? 1 : isHeading ? 2 : null,
        isBold: Boolean(block.isBold),
        isItalic: Boolean(block.isItalic),
        page: page.page,
        layoutLabel: block.layoutLabel,
        layout: block.layout,
      });
    }
  }
  return mergePdfColumnContinuations(passages);
}

function mergePdfColumnContinuations(passages) {
  const merged = [];
  for (const passage of passages) {
    const previous = merged.at(-1);
    const adjacentPages = previous && Number.isInteger(previous.page) && Number.isInteger(passage.page)
      && passage.page >= previous.page && passage.page <= previous.page + 1;
    const sameTextFlow = previous?.type === "paragraph" && passage.type === "paragraph" && adjacentPages
      && previous.layoutLabel === "Text" && passage.layoutLabel === "Text";
    const samePage = sameTextFlow && previous.page === passage.page;
    const pageWidth = passage.layout?.pageWidth || previous?.layout?.pageWidth || 0;
    const jumpsToNextColumn = samePage && pageWidth > 0
      && passage.layout.x1 > previous.layout.x1 + pageWidth * 0.18
      && passage.layout.y1 < previous.layout.y1;
    const startsMidSentence = sameTextFlow && /^(?:[“‘"']\s*)?\p{Ll}/u.test(passage.text);
    const previousWithoutTrailingCitations = previous?.text.replace(/(?:\s*\[[\d,;\s-]+\])+\s*$/u, "").trim() || "";
    const previousSentenceFinished = /[.!?…:;][”’"')\]]?$/u.test(previousWithoutTrailingCitations);
    const crossesPage = sameTextFlow && passage.page === previous.page + 1;
    const sentenceContinues = startsMidSentence || !previousSentenceFinished;
    if (sentenceContinues && (jumpsToNextColumn || startsMidSentence && (samePage || crossesPage))) {
      const hyphenated = /-$/u.test(previous.text) && /^\p{Ll}/u.test(passage.text);
      const prefix = previous.text.replace(hyphenated ? /-$/u : /$/u, "");
      const separator = hyphenated ? "" : " ";
      const rangeOffset = prefix.length + separator.length;
      previous.text = `${prefix}${separator}${passage.text}`;
      previous.superscriptRanges = [
        ...(previous.superscriptRanges || []).filter((range) => range.end <= prefix.length),
        ...(passage.superscriptRanges || []).map((range) => ({ start: range.start + rangeOffset, end: range.end + rangeOffset })),
      ];
      previous.layout = { ...previous.layout, x2: Math.max(previous.layout.x2, passage.layout.x2), y2: Math.max(previous.layout.y2, passage.layout.y2) };
      continue;
    }
    merged.push(passage);
  }
  return merged;
}

function extractPdfSuperscripts(markedText) {
  let text = "";
  const superscriptRanges = [];
  let superscriptStart = null;
  for (const character of markedText) {
    if (character === "\uE100") {
      if (superscriptStart === null) superscriptStart = text.length;
    } else if (character === "\uE101") {
      if (superscriptStart !== null && text.length > superscriptStart) superscriptRanges.push({ start: superscriptStart, end: text.length });
      superscriptStart = null;
    } else text += character;
  }
  if (superscriptStart !== null && text.length > superscriptStart) superscriptRanges.push({ start: superscriptStart, end: text.length });
  return { text, superscriptRanges };
}

function removeRepeatedPdfMarginals(passages) {
  const pagesByText = new Map();
  const marginalPosition = (passage) => {
    if (!passage.pdfText || !Number.isInteger(passage.page) || !passage.layout) return "";
    const { y1, y2, pageHeight } = passage.layout;
    if (!(Number.isFinite(y1) && Number.isFinite(y2) && pageHeight > 0)) return "";
    if (y2 <= pageHeight * 0.12) return "top";
    if (y1 >= pageHeight * 0.88) return "bottom";
    return "";
  };
  const marginalKey = (passage) => {
    const position = marginalPosition(passage);
    if (!position) return "";
    const text = passage.text.normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase();
    return text.length >= 4 && text.length <= 240 ? `${position}:${text}` : "";
  };
  for (const passage of passages) {
    const key = marginalKey(passage);
    if (!key) continue;
    if (!pagesByText.has(key)) pagesByText.set(key, new Set());
    pagesByText.get(key).add(passage.page);
  }
  const repeated = new Set([...pagesByText].filter(([, pages]) => pages.size >= 2).map(([key]) => key));
  return passages.filter((passage) => {
    if (repeated.has(marginalKey(passage))) return false;
    const position = marginalPosition(passage);
    const text = passage.text?.replace(/\s+/g, " ").trim() || "";
    const protectedContent = passage.headingLevel === 1 || ["Title", "Section-header", "Caption"].includes(passage.layoutLabel);
    const likelyRunningHeaderOrFooter = position && !protectedContent
      && ["Text", "Footnote"].includes(passage.layoutLabel)
      && text.length >= 1
      && text.length <= 120;
    return !likelyRunningHeaderOrFooter;
  });
}

const PDF_PREPOSED_DIACRITICS = new Map([
  ["´", "\u0301"], ["ˊ", "\u0301"], ["`", "\u0300"], ["ˋ", "\u0300"],
  ["ˆ", "\u0302"], ["^", "\u0302"], ["¨", "\u0308"], ["˜", "\u0303"],
  ["~", "\u0303"], ["ˇ", "\u030C"], ["˘", "\u0306"], ["˙", "\u0307"],
  ["˚", "\u030A"], ["°", "\u030A"], ["¯", "\u0304"], ["¸", "\u0327"],
]);

function normalizePdfTypography(value) {
  let text = value
    .replace(/\u00ad/g, "")
    .replace(/\ufb00/g, "ff").replace(/\ufb01/g, "fi").replace(/\ufb02/g, "fl")
    .replace(/\ufb03/g, "ffi").replace(/\ufb04/g, "ffl")
    .replace(/([cdjlstn])´(?=[aeiouyh])/giu, "$1’")
    .replace(/\b([Ww])\s+(hat|hen|here|hich|hile|ho|hom|hy|ith|ould)\b/gu, "$1$2");
  const marks = [...PDF_PREPOSED_DIACRITICS.keys()].map(escapeRegExp).join("");
  const allowed = new Map([
    ["\u0301", /[aceilnorsuyz]/iu], ["\u0300", /[aeiou]/iu], ["\u0302", /[aeiou]/iu],
    ["\u0308", /[aeiouy]/iu], ["\u0303", /[ano]/iu], ["\u030C", /[cdelnrstz]/iu],
    ["\u0306", /[ag]/iu], ["\u0307", /[cegiz]/iu], ["\u030A", /[au]/iu],
    ["\u0304", /[aeiouy]/iu], ["\u0327", /[cst]/iu],
  ]);
  text = text.replace(new RegExp(`([${marks}])\\s*([A-Za-zÀ-ÖØ-öø-ÿ])`, "gu"), (source, mark, letter) => {
    const combining = PDF_PREPOSED_DIACRITICS.get(mark);
    return allowed.get(combining)?.test(letter) ? `${letter}${combining}` : source;
  });
  text = text.replace(/([A-Za-zÀ-ÖØ-öø-ÿ])\s+([\u0300-\u036f])/gu, "$1$2");
  return text.normalize("NFC");
}

function escapeRegExp(value) {
  return value.replace(/[\\^$.*+?()[\]{}|\-]/g, "\\$&");
}

function extractPdfLocally(bytes, onPage) {
  return new Promise((resolve, reject) => {
    const engineName = "PDF.js";
    const worker = new Worker(chrome.runtime.getURL("pdfjs-pdf-worker.js"), { type: "module" });
    const streamedPages = [];
    const engineTimeout = setTimeout(() => {
      worker.terminate();
      reject(new Error(`${engineName} did not initialize within 30 seconds.`));
    }, 30000);
    worker.onmessage = ({ data }) => {
      if (data.type === "booting") {
        setStatus({ state: "loading", message: `Loading local ${engineName} engine…` });
      } else if (data.type === "ready") {
        clearTimeout(engineTimeout);
        setStatus({ state: "loading", message: `${engineName} ready · opening document…` });
        worker.postMessage({ type: "extract", bytes }, [bytes]);
      } else if (data.type === "opening") {
        setStatus({ state: "loading", message: "Opening PDF document…" });
      } else if (data.type === "progress") {
        setStatus({ state: "loading", message: `${engineName} · page ${data.current} of ${data.total}` });
      } else if (data.type === "page") {
        streamedPages.push(data.page);
        onPage?.(data.page, data.pageCount);
      } else if (data.type === "math-progress") {
        const detail = data.progress?.status === "progress" && Number.isFinite(data.progress.progress) ? ` · ${Math.round(data.progress.progress)}%` : "";
        setStatus({ state: "loading", message: `Loading local math OCR${detail}` });
      } else if (data.type === "math-warning") {
        console.warn("Math OCR skipped:", data.message);
      } else if (data.type === "table-progress") {
        const detail = data.progress?.status === "progress" && Number.isFinite(data.progress.progress) ? ` · ${Math.round(data.progress.progress)}%` : "";
        setStatus({ state: "loading", message: `Loading local table recognition${detail}` });
      } else if (data.type === "table-warning") {
        console.warn("Table recognition skipped:", data.message);
      } else if (data.type === "result") {
        clearTimeout(engineTimeout);
        worker.terminate();
        if (data.streamed) data.pages = streamedPages;
        resolve(data);
      } else if (data.type === "error") {
        clearTimeout(engineTimeout);
        worker.terminate();
        reject(new Error(data.message));
      }
    };
    worker.onerror = ({ message }) => { clearTimeout(engineTimeout); worker.terminate(); reject(new Error(message || "PDF extraction failed.")); };
  });
}

async function fetchPdf(url, onPage) {
  setStatus({ state: "loading", message: "Downloading PDF…" });
  const controller = new AbortController();
  let timeout = setTimeout(() => controller.abort(), 60000);
  const resetTimeout = () => {
    clearTimeout(timeout);
    timeout = setTimeout(() => controller.abort(), 60000);
  };
  let response;
  try {
    response = await fetch(url, { credentials: "include", signal: controller.signal });
  } catch (error) {
    clearTimeout(timeout);
    if (error.name === "AbortError") throw new Error("PDF download timed out. The server did not respond for 60 seconds.");
    throw new Error(`Could not fetch this PDF: ${error.message}`);
  }
  if (!response.ok) { clearTimeout(timeout); throw new Error(`Could not download PDF (${response.status}).`); }
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("text/html")) { clearTimeout(timeout); throw new Error("The PDF URL returned an HTML page, possibly a sign-in screen."); }
  const total = Number(response.headers.get("content-length")) || 0;
  const chunks = [];
  let loaded = 0;
  try {
    if (!response.body) {
      const buffer = await response.arrayBuffer();
      chunks.push(new Uint8Array(buffer));
      loaded = buffer.byteLength;
    } else {
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        resetTimeout();
        chunks.push(value);
        loaded += value.byteLength;
        const progress = total
          ? `${(loaded / 1e6).toFixed(1)} / ${(total / 1e6).toFixed(1)} MB`
          : `${(loaded / 1e6).toFixed(1)} MB`;
        setStatus({ state: "loading", message: `Downloading PDF · ${progress}` });
      }
    }
  } catch (error) {
    if (error.name === "AbortError") throw new Error("PDF download stalled for more than 60 seconds.");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  const pdfBytes = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) { pdfBytes.set(chunk, offset); offset += chunk.byteLength; }
  setStatus({ state: "loading", message: `Opening ${(loaded / 1e6).toFixed(1)} MB PDF…` });
  const bytes = pdfBytes.buffer;
  return extractPdfLocally(bytes, onPage);
}

function chunks(text, limit = 340) {
  if (text.length <= limit) return [text];
  const sentences = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [text];
  const result = [];
  let current = "";
  for (const sentence of sentences) {
    if (current && current.length + sentence.length > limit) { result.push(current.trim()); current = ""; }
    current += sentence;
  }
  if (current.trim()) result.push(current.trim());
  return result;
}

function sentences(text) {
  if (typeof Intl.Segmenter === "function") {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "sentence" });
    const result = [...segmenter.segment(text)].map(({ segment }) => segment.trim()).filter(Boolean);
    if (result.length) return result;
  }
  return text.match(/[^.!?]+(?:[.!?]+|$)/g)?.map((sentence) => sentence.trim()).filter(Boolean) || [text];
}

function appendPdfCitationText(container, text, references, isReferenceEntry) {
  if (isReferenceEntry) { appendLinkifiedPdfText(container, text); return; }
  const citationPattern = /\[(?:\d+\s*(?:[,;–-]\s*\d+\s*)*)\]/g;
  let offset = 0;
  for (const match of text.matchAll(citationPattern)) {
    appendLinkifiedPdfText(container, text.slice(offset, match.index));
    const marker = match[0];
    let markerOffset = 0;
    for (const numberMatch of marker.matchAll(/\d+/g)) {
      container.append(document.createTextNode(marker.slice(markerOffset, numberMatch.index)));
      const number = numberMatch[0];
      if (references.has(number)) {
        const link = document.createElement("a");
        link.className = "pdf-citation";
        link.href = `#pdf-ref-${number}`;
        link.textContent = number;
        link.title = `Jump to reference ${number}`;
        container.append(link);
      } else container.append(document.createTextNode(number));
      markerOffset = numberMatch.index + number.length;
    }
    container.append(document.createTextNode(marker.slice(markerOffset)));
    offset = match.index + marker.length;
  }
  appendLinkifiedPdfText(container, text.slice(offset));
}

function appendLinkifiedPdfText(container, text) {
  let offset = 0;
  for (const match of linkMatches(text)) {
    container.append(document.createTextNode(text.slice(offset, match.start)));
    try {
      const link = document.createElement("a");
      link.className = "pdf-external-link";
      link.href = match.href;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = match.label;
      link.title = match.schema === "mailto:" ? `Email ${match.label}` : `Open ${new URL(match.href).hostname}`;
      container.append(link);
    } catch {
      container.append(document.createTextNode(match.label));
    }
    offset = match.end;
  }
  container.append(document.createTextNode(text.slice(offset)));
}

function textForSpeech(text) {
  let spoken = "";
  let offset = 0;
  for (const match of linkMatches(text)) {
    spoken += text.slice(offset, match.start);
    try {
      if (match.schema === "mailto:") {
        const [user, domain] = match.label.split("@");
        spoken += `${user} at ${domain.split(".").join(" dot ")}`;
      } else {
        const url = new URL(match.href);
        spoken += url.hostname.replace(/^www\./iu, "").split(".").filter(Boolean).join(" dot ");
      }
    } catch {
      spoken += match.label;
    }
    offset = match.end;
  }
  return spoken + text.slice(offset);
}

function normalizeTTSTextForEngine(text) {
  return text
    .replace(/[\u2018\u2019\u02BC]/gu, "'")
    .replace(/[\u201C\u201D]/gu, "");
}

function associatePdfVisuals(passages) {
  const figures = new Set();
  const tables = new Set();
  for (const passage of passages) {
    delete passage.figureNumber;
    delete passage.tableNumber;
    delete passage.visualCaption;
  }
  for (const caption of passages) {
    const match = caption.pdfText ? caption.text.match(/^\s*(Figure|Fig\.?|Table)[\s ]+(\d+[A-Za-z]?)/iu) : null;
    if (!match) continue;
    const kind = /^table$/iu.test(match[1]) ? "table" : "figure";
    const number = match[2].toLowerCase();
    const candidates = passages.filter((passage) => {
      const matchingVisual = kind === "figure"
        ? passage.type === "image" && !/^table$/iu.test(passage.image?.alt || "")
        : passage.type === "table" || (passage.type === "image" && /^table$/iu.test(passage.image?.alt || ""));
      return matchingVisual && passage.page === caption.page && passage.layout
        && !(kind === "figure" ? passage.figureNumber : passage.tableNumber);
    });
    if (!candidates.length) continue;
    const visual = candidates.sort((left, right) => figureCaptionDistance(left.layout, caption.layout) - figureCaptionDistance(right.layout, caption.layout))[0];
    visual[kind === "figure" ? "figureNumber" : "tableNumber"] = number;
    visual.visualCaption = caption.text;
    caption[kind === "figure" ? "figureCaptionNumber" : "tableCaptionNumber"] = number;
    (kind === "figure" ? figures : tables).add(number);
  }
  return { figures, tables };
}

function figureCaptionDistance(image, caption) {
  if (!image || !caption) return Number.POSITIVE_INFINITY;
  const verticalGap = caption.y1 >= image.y2 ? caption.y1 - image.y2 : image.y1 >= caption.y2 ? image.y1 - caption.y2 : 0;
  const horizontalGap = Math.max(0, Math.max(image.x1, caption.x1) - Math.min(image.x2, caption.x2));
  const captionBelowBonus = caption.y1 >= image.y2 ? 0 : (image.pageHeight || 1000) * 0.12;
  return verticalGap + horizontalGap * 0.5 + captionBelowBonus;
}

function appendPdfLinkedText(container, text, references, visuals, isReferenceEntry) {
  const pattern = /\b(Figure|Fig\.?|Table)\s+(\d+[A-Za-z]?)\b/giu;
  let offset = 0;
  for (const match of text.matchAll(pattern)) {
    appendPdfCitationText(container, text.slice(offset, match.index), references, isReferenceEntry);
    const kind = /^table$/iu.test(match[1]) ? "table" : "figure";
    const number = match[2].toLowerCase();
    if (visuals[`${kind}s`].has(number)) {
      const link = document.createElement("a");
      link.className = `pdf-citation pdf-visual-link pdf-${kind}-link`;
      link.href = `#pdf-${kind}-${number}`;
      link.textContent = match[0];
      link.title = `Jump to ${kind} ${match[2]}`;
      container.append(link);
    } else container.append(document.createTextNode(match[0]));
    offset = match.index + match[0].length;
  }
  appendPdfCitationText(container, text.slice(offset), references, isReferenceEntry);
}

function appendPdfStyledText(container, text, textStart, superscriptRanges, references, visuals, isReferenceEntry) {
  const textEnd = textStart + text.length;
  const boundaries = new Set([0, text.length]);
  for (const range of superscriptRanges || []) {
    if (range.end <= textStart || range.start >= textEnd) continue;
    boundaries.add(Math.max(0, range.start - textStart));
    boundaries.add(Math.min(text.length, range.end - textStart));
  }
  const offsets = [...boundaries].sort((left, right) => left - right);
  for (let index = 0; index < offsets.length - 1; index += 1) {
    const start = offsets[index];
    const end = offsets[index + 1];
    if (end <= start) continue;
    const segment = text.slice(start, end);
    const isSuperscript = (superscriptRanges || []).some((range) => range.start <= textStart + start && range.end >= textStart + end);
    const target = isSuperscript ? document.createElement("sup") : container;
    appendPdfLinkedText(target, segment, references, visuals, isReferenceEntry);
    if (isSuperscript) container.append(target);
  }
}

function showCitationPreview(citation) {
  const hash = citation.getAttribute("href");
  if (!hash?.startsWith("#pdf-")) return;
  const target = document.querySelector(hash);
  if (!target) return;
  const preview = $("#citationPreview");
  const visualMatch = hash.match(/^#pdf-(figure|table)-(.+)$/u);
  const media = preview.querySelector(".citation-preview-media");
  const description = preview.querySelector("p");
  media.replaceChildren();
  if (visualMatch) {
    preview.querySelector("strong").textContent = `${visualMatch[1]} ${visualMatch[2]}`;
    const visual = target.querySelector(visualMatch[1] === "table" ? ":scope > table, :scope > img" : ":scope > img");
    if (visual) media.append(visual.cloneNode(true));
    media.hidden = !visual;
    description.textContent = target.dataset.previewCaption || "";
  } else {
    const number = hash.slice("#pdf-ref-".length);
    preview.querySelector("strong").textContent = `Reference ${number}`;
    media.hidden = true;
    description.textContent = target.textContent.trim();
  }
  description.hidden = !description.textContent;
  preview.hidden = false;
  const linkRect = citation.getBoundingClientRect();
  const previewRect = preview.getBoundingClientRect();
  const gap = 9;
  const left = Math.min(window.innerWidth - previewRect.width - 12, Math.max(12, linkRect.left + linkRect.width / 2 - previewRect.width / 2));
  const below = linkRect.bottom + gap;
  const top = below + previewRect.height <= window.innerHeight - 12
    ? below
    : Math.max(12, linkRect.top - previewRect.height - gap);
  preview.style.left = `${left}px`;
  preview.style.top = `${top}px`;
  citation.setAttribute("aria-describedby", "citationPreview");
}

function hideCitationPreview(citation) {
  $("#citationPreview").hidden = true;
  citation?.removeAttribute("aria-describedby");
}

function associatePdfReferences(passages) {
  const entries = new Map();
  let inBibliography = false;
  const bibliographyHeading = /^\s*(?:\d+(?:\.\d+)*[.)]?\s+)?(?:references(?:\s+and\s+notes)?|bibliography|works\s+cited)\s*:?[\s.]*$/iu;
  const bracketedEntry = /^\s*\[(\d{1,3})\](?:\s|$)/u;
  const numberedEntry = /^\s*(\d{1,3})[.)](?:\s|$)/u;

  passages.forEach((passage) => {
    if (!passage.pdfText || !passage.text) return;
    if (bibliographyHeading.test(passage.text)) {
      inBibliography = true;
      return;
    }
    const bracketed = passage.text.match(bracketedEntry)?.[1];
    const numbered = inBibliography ? passage.text.match(numberedEntry)?.[1] : null;
    if (bracketed || numbered) entries.set(passage, bracketed || numbered);
  });

  if (![...entries.values()].some((number) => passages.findIndex((passage) => entries.get(passage) === number) >= passages.length * 0.6)) {
    const tailCandidates = passages.slice(Math.floor(passages.length * 0.6))
      .map((passage) => ({ passage, number: passage.pdfText ? Number(passage.text.match(numberedEntry)?.[1]) : NaN }))
      .filter(({ number }) => Number.isInteger(number));
    const sequential = tailCandidates.length >= 2
      && tailCandidates[0].number <= 3
      && tailCandidates.every((candidate, index) => index === 0 || candidate.number > tailCandidates[index - 1].number);
    if (sequential) tailCandidates.forEach(({ passage, number }) => entries.set(passage, String(number)));
  }

  return { entries, numbers: new Set(entries.values()) };
}

function render(metadata, passages, sourceUrl) {
  const article = $("#article");
  activeSourceUrl = sourceUrl;
  article.replaceChildren();
  try { article.classList.toggle("youtube-transcript", /^(?:www\.|m\.)?youtube\.com$/i.test(new URL(sourceUrl).hostname)); }
  catch { article.classList.remove("youtube-transcript"); }
  const title = metadata.title || passages.find((passage) => passage.type === "heading")?.text || new URL(sourceUrl).hostname;
  if (!metadata.hideTitle) {
    const heading = document.createElement("h1");
    heading.textContent = title;
    article.append(heading);
  }
  const details = [metadata.author, metadata.site, metadata.published?.slice(0, 10)].filter(Boolean);
  if (details.length) { const byline = document.createElement("p"); byline.className = "byline"; byline.textContent = details.join(" · "); article.append(byline); }
  const referenceIndex = associatePdfReferences(passages);
  const references = referenceIndex.numbers;
  const visuals = associatePdfVisuals(passages);
  passages.forEach((passage, index) => {
    if (!metadata.hideTitle && index === 0 && passage.type === "heading" && passage.text === title) return;
    const element = document.createElement(passage.type === "heading" ? (passage.headingLevel === 1 ? "h1" : "h2") : ["image", "formula"].includes(passage.type) ? "figure" : passage.type === "table" ? "section" : "p");
    element.className = `passage ${passage.type}`;
    if (passage.pdfText) {
      element.classList.add("pdf-text");
      element.classList.toggle("pdf-title", passage.headingLevel === 1);
      element.classList.toggle("pdf-bold", Boolean(passage.isBold));
      element.classList.toggle("pdf-italic", Boolean(passage.isItalic));
    }
    element.dataset.index = index;
    const referenceNumber = referenceIndex.entries.get(passage) || null;
    if (referenceNumber) element.id = `pdf-ref-${referenceNumber}`;
    if (passage.figureNumber) element.id = `pdf-figure-${passage.figureNumber}`;
    if (passage.tableNumber) element.id = `pdf-table-${passage.tableNumber}`;
    if (passage.visualCaption) element.dataset.previewCaption = passage.visualCaption;
    if (passage.type === "table") {
      const table = document.createElement("table");
      for (const row of passage.table.rows) {
        const tr = document.createElement("tr");
        for (const cell of row.cells) {
          const td = document.createElement(cell.header ? "th" : "td");
          td.textContent = normalizePdfTypography(cell.text || "");
          tr.append(td);
        }
        table.append(tr);
      }
      element.append(table);
      if (passage.image?.src) {
        const details = document.createElement("details");
        const summary = document.createElement("summary");
        summary.textContent = "Show original table image";
        const image = document.createElement("img");
        image.src = passage.image.src;
        image.alt = passage.image.alt;
        details.append(summary, image);
        element.append(details);
      }
    } else if (passage.type === "formula") {
      element.classList.add("formula");
      const math = document.createElement("div");
      math.className = "math-render";
      math.innerHTML = renderMath(passage.latex);
      math.title = passage.latex;
      element.append(math);
      const details = document.createElement("details");
      const summary = document.createElement("summary");
      summary.textContent = "LaTeX";
      const code = document.createElement("code");
      code.textContent = passage.latex;
      details.append(summary, code);
      element.append(details);
    } else if (passage.type === "image") {
      const image = document.createElement("img");
      image.src = passage.image.src;
      image.alt = passage.image.alt || "";
      image.loading = "lazy";
      element.append(image);
    }
    let passageTextOffset = 0;
    passage.sentences.forEach((sentence, sentenceIndex) => {
      if (["image", "formula", "table"].includes(passage.type) && sentenceIndex === 0) element.append(document.createElement("br"));
      else if (sentenceIndex) element.append(" ");
      const span = document.createElement("span");
      span.className = "sentence";
      span.dataset.sentence = sentenceIndex;
      span.tabIndex = 0;
      span.setAttribute("role", "button");
      const youtubeStart = passage.youtubeSentenceStarts?.[sentenceIndex];
      if (Number.isFinite(youtubeStart)) {
        span.dataset.youtubeStart = youtubeStart;
        span.classList.add("youtube-sentence");
        span.title = `Play the video from ${formatVideoTime(youtubeStart)}`;
      } else span.title = "Read from this sentence";
      const sentenceTextOffset = passage.pdfText ? passage.text.indexOf(sentence, passageTextOffset) : -1;
      if (passage.pdfText) {
        appendPdfStyledText(span, sentence, Math.max(0, sentenceTextOffset), passage.superscriptRanges, references, visuals, Boolean(referenceNumber));
        passageTextOffset = Math.max(passageTextOffset, sentenceTextOffset + sentence.length);
      }
      else span.textContent = sentence;
      element.append(span);
    });
    article.append(element);
  });
}

function markCurrent(index, sentenceIndex = 0) {
  document.querySelectorAll(".passage").forEach((element) => {
    const elementIndex = Number(element.dataset.index);
    element.classList.toggle("current", elementIndex === index);
    element.classList.toggle("done", elementIndex < index);
    element.querySelectorAll(".sentence").forEach((sentence) => {
      const currentSentence = Number(sentence.dataset.sentence);
      sentence.classList.toggle("current", elementIndex === index && currentSentence === sentenceIndex);
      sentence.classList.toggle("done", elementIndex < index || (elementIndex === index && currentSentence < sentenceIndex));
    });
  });
  document.querySelector(`.passage[data-index="${index}"] .sentence[data-sentence="${sentenceIndex}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
}

async function readArticle() {
  if (state.reading) return;
  if (state.index >= state.passages.length) { state.index = 0; state.sentence = 0; }
  state.reading = true;
  const run = ++state.run;
  $("#play").disabled = true;
  $("#stop").disabled = false;
  try {
    while (state.index < state.passages.length && run === state.run) {
      const passage = state.passages[state.index];
      while (state.sentence < passage.sentences.length && run === state.run) {
        const sentence = passage.sentences[state.sentence];
        markCurrent(state.index, state.sentence);
        setStatus({ state: "speaking", message: `Paragraph ${state.index + 1} · sentence ${state.sentence + 1} of ${passage.sentences.length}` });
        const spokenText = normalizeTTSTextForEngine(textForSpeech(sentence));
        for (const chunk of chunks(spokenText)) {
          if (run !== state.run) break;
          await activeTts().speak(chunk, {
            speed: $("#provider").value === "pocket" ? 1 : Number($("#speed").value),
            voice: $("#voice").value,
          });
        }
        if (run === state.run) state.sentence++;
      }
      if (run !== state.run) break;
      state.sentence = 0;
      state.index++;
    }
    if (run === state.run) { markCurrent(state.passages.length); setStatus({ state: "ready", message: "Finished" }); }
  } catch (error) {
    if (run === state.run) setStatus({ state: "error", message: error.message });
  } finally {
    if (run === state.run) {
      state.reading = false;
      $("#play").disabled = false;
      $("#play span").textContent = state.index ? "Continue reading" : "Read article";
      $("#stop").disabled = true;
    }
  }
}

function readFromPosition(index, sentenceIndex = 0) {
  const passage = state.passages[index];
  if (!passage || !Number.isInteger(sentenceIndex) || sentenceIndex < 0 || sentenceIndex >= passage.sentences.length) return;
  const youtubeStart = passage.youtubeSentenceStarts?.[sentenceIndex];
  if (Number.isFinite(youtubeStart)) {
    void playYouTubeAt(youtubeStart);
    return;
  }
  state.run++;
  state.reading = false;
  state.index = index;
  state.sentence = sentenceIndex;
  inflectTts.stop();
  pocketTts.stop();
  markCurrent(index, sentenceIndex);
  void readArticle();
}

function formatVideoTime(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

async function playYouTubeAt(milliseconds) {
  const seconds = Math.max(0, milliseconds / 1000);
  let videoId = "";
  try { videoId = new URL(activeSourceUrl).searchParams.get("v") || ""; } catch {}
  try {
    const tabs = await chrome.tabs.query({ url: ["https://www.youtube.com/watch*", "https://m.youtube.com/watch*"] });
    const tab = tabs.find((candidate) => {
      try { return new URL(candidate.url).searchParams.get("v") === videoId; } catch { return false; }
    });
    if (tab?.id) {
      const [{ result: played } = {}] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: async (time) => {
          const video = document.querySelector("video");
          if (!video) return false;
          video.currentTime = time;
          try { await video.play(); } catch {}
          return true;
        },
        args: [seconds],
      });
      if (played) {
        await chrome.tabs.update(tab.id, { active: true });
        setStatus({ state: "ready", message: `Playing YouTube from ${formatVideoTime(milliseconds)}` });
        return;
      }
    }
  } catch (error) {
    console.warn("Could not seek the existing YouTube tab:", error);
  }
  const url = new URL(activeSourceUrl);
  url.searchParams.set("t", `${Math.floor(seconds)}s`);
  await chrome.tabs.create({ url: url.href });
}

function stopReading() {
  state.run++;
  state.reading = false;
  inflectTts.stop();
  pocketTts.stop();
  $("#play").disabled = false;
  $("#play span").textContent = "Continue reading";
  $("#stop").disabled = true;
  setStatus({ state: "ready", message: `Paused at paragraph ${state.index + 1}, sentence ${state.sentence + 1}` });
}

async function loadArticle() {
  const params = new URLSearchParams(location.search);
  const extractionError = params.get("error");
  if (extractionError) throw new Error(extractionError === "unsupported" ? "Open a regular web page or PDF, then click the extension button." : extractionError);
  const documentId = params.get("doc");
  if (documentId) {
    const saved = await getDocument(documentId);
    if (!saved) throw new Error("This locally saved document is no longer available.");
    await touchDocument(documentId);
    activeDocumentId = documentId;
    $("#deleteDocument").hidden = false;
    state.language = saved.language || "";
    summaryLanguagePromise = null;
    state.passages = (saved.passages || []).map((passage) => ({ ...passage, sentences: passage.text ? sentences(passage.text) : [] }));
    if (!state.passages.length) throw new Error("This saved document contains no readable text.");
    $("#sourceLink").href = saved.sourceUrl;
    try { $("#sourceLink").textContent = saved.kind === "pdf" ? (saved.metadata?.displayTitle || "PDF document") : new URL(saved.sourceUrl).hostname; }
    catch { $("#sourceLink").textContent = saved.metadata?.displayTitle || "Saved document"; }
    $("#reprocessPdf").hidden = saved.kind !== "pdf";
    render(saved.metadata || {}, state.passages, saved.sourceUrl);
    $("#play").disabled = !state.passages.some((passage) => passage.sentences.length);
    documentReady = true;
    if (!restoreSavedSummary(saved.summary)) void maybeSummarizeAutomatically();
    void indexSavedDocument(saved);
    setStatus({ state: "ready", message: `Restored locally · ${state.passages.length} passages ready` });
    return;
  }
  const pdfUrl = params.get("pdf");
  if (pdfUrl) {
    const filename = decodeURIComponent(new URL(pdfUrl).pathname.split("/").pop() || "PDF document").replace(/\.pdf$/i, "");
    const cached = await getDocumentByUrl(pdfUrl);
    if (cached?.kind === "pdf" && params.get("reprocess") !== "1") {
      history.replaceState(null, "", `reader.html?doc=${encodeURIComponent(cached.id)}`);
      return loadArticle();
    }
    $("#sourceLink").href = pdfUrl;
    $("#sourceLink").textContent = filename;
    $("#reprocessPdf").hidden = false;
    const extracted = await fetchPdf(pdfUrl, (page, pageCount) => {
      const rawPassages = pdfBlockPassages([page]);
      state.passages.push(...rawPassages.map((passage) => ({ ...passage, sentences: passage.text ? sentences(passage.text) : [] })));
      render({ title: "", hideTitle: true }, state.passages, pdfUrl);
      $("#play").disabled = !state.passages.some((passage) => passage.sentences.length);
      setStatus({ state: "loading", message: `Rendered page ${page.page} of ${pageCount}` });
    });
    const metadata = {
      title: pdfTitleFromPages(extracted.pages || []) || filename,
      hideTitle: true,
      site: `${extracted.pageCount} pages`,
      displayTitle: filename,
    };
    if (!extracted.streamed) {
      const rawPassages = extracted.format === "blocks" ? pdfBlockPassages(extracted.pages) : pdfMarkdownPassages(extracted.markdown, pdfUrl);
      state.passages = rawPassages.map((passage) => ({ ...passage, sentences: passage.text ? sentences(passage.text) : [] }));
    }
    if (extracted.format === "blocks") {
      state.passages = mergePdfColumnContinuations(removeRepeatedPdfMarginals(state.passages))
        .map((passage) => ({ ...passage, sentences: passage.text ? sentences(passage.text) : [] }));
    }
    if (!state.passages.length) throw new Error("This PDF contains no extractable text. Scanned PDFs require OCR.");
    render(metadata, state.passages, pdfUrl);
    $("#play").disabled = false;
    documentReady = true;
    await persistDocument({ kind: "pdf", sourceUrl: pdfUrl, metadata, passages: state.passages, language: state.language, pageCount: extracted.pageCount, summary: null, embeddingChunks: null });
    void maybeSummarizeAutomatically();
    setStatus({ state: "ready", message: `${extracted.pageCount} PDF pages · saved locally` });
    return;
  }
  const id = params.get("id");
  if (!id) throw new Error("Click the extension button on an article to prepare a reader tab.");
  const stored = await chrome.storage.session.get(id);
  const article = stored[id];
  await chrome.storage.session.remove(id);
  if (!article?.content) throw new Error("The locally extracted article has expired. Click the extension again.");
  const sourceUrl = article.sourceUrl;
  state.language = article.language || "";
  summaryLanguagePromise = null;
  $("#sourceLink").href = sourceUrl;
  $("#sourceLink").textContent = new URL(sourceUrl).hostname;
  const metadata = {
    title: article.title,
    author: article.byline,
    site: article.siteName,
    published: article.publishedTime,
    word_count: Math.round((article.textContent || "").trim().split(/\s+/).length),
  };
  let youtubeParagraphIndex = 0;
  state.passages = htmlPassages(article.content, sourceUrl).map((passage) => {
    const prepared = { ...passage, sentences: passage.text ? sentences(passage.text) : [] };
    if (article.kind === "youtube" && passage.type === "paragraph") prepared.youtubeSentenceStarts = article.paragraphSentenceStarts?.[youtubeParagraphIndex++] || [];
    return prepared;
  });
  if (!state.passages.length) throw new Error("No readable article text was found.");
  render(metadata, state.passages, sourceUrl);
  $("#play").disabled = false;
  documentReady = true;
  await persistDocument({ kind: article.kind === "youtube" ? "youtube" : "article", sourceUrl, metadata, passages: state.passages, language: state.language, summary: null, videoId: article.videoId, duration: article.duration, chapters: article.chapters });
  void maybeSummarizeAutomatically();
  setStatus({ state: "ready", message: `${state.passages.length} passages ready · saved locally` });
}

$("#play").addEventListener("click", readArticle);
$("#stop").addEventListener("click", stopReading);
$("#reprocessPdf").addEventListener("click", () => {
  const sourceUrl = $("#sourceLink").href;
  if (!sourceUrl) return;
  location.href = `reader.html?pdf=${encodeURIComponent(sourceUrl)}&reprocess=1`;
});
$("#deleteDocument").addEventListener("click", async () => {
  if (!activeDocumentId) return;
  const label = $("#sourceLink").textContent.trim() || "this document";
  if (!confirm(`Delete ${label} from your local library?`)) return;
  const button = $("#deleteDocument");
  button.disabled = true;
  if (state.reading) stopReading();
  try {
    await removeDocument(activeDocumentId);
    location.href = "library.html";
  } catch (error) {
    button.disabled = false;
    setStatus({ state: "error", message: `Could not delete this document: ${error.message}` });
  }
});
$("#summarize").addEventListener("click", () => {
  if (summaryStarted) return;
  summaryStarted = true;
  $("#summaryText").hidden = true;
  $("#summaryLoading").hidden = false;
  void summarizeLocally();
});
$("#model").addEventListener("change", (event) => {
  if (state.reading) stopReading();
  inflectTts.setModel(event.target.value);
  void savePreferences();
});
$("#voice").addEventListener("change", (event) => {
  if (state.reading) stopReading();
  pocketTts.setVoice(event.target.value);
  void savePreferences();
});
$("#provider").addEventListener("change", (event) => {
  if (state.reading) stopReading();
  else { inflectTts.stop(); pocketTts.stop(); }
  applyProviderUI();
  void savePreferences();
});
$("#speed").addEventListener("change", () => { void savePreferences(); });
$("#clearCache").addEventListener("click", async () => {
  if (state.reading) stopReading();
  const button = $("#clearCache");
  button.disabled = true;
  setStatus({ state: "loading", message: "Clearing cached models and voices…" });
  try {
    await Promise.all([inflectTts.clearCache(), pocketTts.clearCache(), caches.delete("transformers-cache")]);
    setStatus({ state: "ready", message: "All cached models and voices cleared" });
  } catch (error) {
    setStatus({ state: "error", message: error.message });
  } finally {
    button.disabled = false;
  }
});
$("#article").addEventListener("click", (event) => {
  if (event.target.closest("a.pdf-external-link")) return;
  const citation = event.target.closest("a.pdf-citation");
  if (citation) {
    event.preventDefault();
    event.stopPropagation();
    const hash = citation.getAttribute("href");
    const target = document.querySelector(hash);
    hideCitationPreview(citation);
    if (target && location.hash !== hash) history.pushState({ pdfCitation: hash }, "", hash);
    target?.scrollIntoView({ behavior: "smooth", block: "center" });
    target?.classList.add("reference-flash");
    setTimeout(() => target?.classList.remove("reference-flash"), 1400);
    return;
  }
  const passage = event.target.closest(".passage");
  if (!passage) return;
  const sentence = event.target.closest(".sentence");
  readFromPosition(Number(passage.dataset.index), sentence ? Number(sentence.dataset.sentence) : 0);
});
$("#article").addEventListener("mouseover", (event) => {
  const citation = event.target.closest("a.pdf-citation[href^='#pdf-']");
  if (citation && !citation.contains(event.relatedTarget)) showCitationPreview(citation);
});
$("#article").addEventListener("mouseout", (event) => {
  const citation = event.target.closest("a.pdf-citation[href^='#pdf-']");
  if (citation && !citation.contains(event.relatedTarget)) hideCitationPreview(citation);
});
$("#article").addEventListener("focusin", (event) => {
  const citation = event.target.closest("a.pdf-citation[href^='#pdf-']");
  if (citation) showCitationPreview(citation);
});
$("#article").addEventListener("focusout", (event) => {
  const citation = event.target.closest("a.pdf-citation[href^='#pdf-']");
  if (citation) hideCitationPreview(citation);
});
$("#article").addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  const passage = event.target.closest(".passage");
  if (!passage) return;
  event.preventDefault();
  const sentence = event.target.closest(".sentence");
  readFromPosition(Number(passage.dataset.index), sentence ? Number(sentence.dataset.sentence) : 0);
});

void setupSummarizer();
restorePreferences().then(loadArticle).catch((error) => {
  $("#article").innerHTML = `<h1>Could not prepare this page</h1><p class="byline"></p>`;
  $("#article .byline").textContent = error.message;
  setStatus({ state: "error", message: error.message });
});
