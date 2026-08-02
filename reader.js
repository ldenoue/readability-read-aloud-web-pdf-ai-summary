import { InflectTTS } from "./inflect-tts.js";
import { PocketTTS } from "./pocket-tts.js";
import { marked } from "./dist/marked.esm.js";
import { renderMath } from "./dist/katex-render.js";
import { linkMatches } from "./dist/linkify.js";
import { renderArticlePdf } from "./dist/pdf-export.js";
import { articleToMarkdown } from "./markdown-export.js";
import { embeddingTexts, getDocument, getDocumentByUrl, removeDocument, saveDocument, touchDocument, updateDocumentEmbeddings, updateDocumentSummary } from "./dist/library-store.js";
import { embedTexts } from "./embedding-client.js";
import { clearGemmaSummarizer, measureGemmaTokens, summarizeWithGemma } from "./summary-client.js";
import { getLocalYouTubeTranscript, youtubeTranscriptArticle } from "./youtube-transcript.js";

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
const CHROME_SUMMARY_PREFERENCE = "speed";
let activeDocumentId = "";
let activeSourceUrl = "";
let activeMetadata = {};
let youtubePlayerLoaded;
const YOUTUBE_APP_IDENTITY = "https://readability-read-aloud.gpgkihaonhnhfabcmgnmkjlmoegfkbne/";
let youtubeSyncTimer = null;
let youtubeTimelineCache = null;
let youtubeHighlightedPosition = "";
let youtubeClockSeconds = 0;
let youtubeClockUpdatedAt = 0;
let youtubeClockPlaying = false;

function dataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error("Could not save PDF image."));
    reader.readAsDataURL(blob);
  });
}

async function imageBlobDimensions(blob) {
  try {
    const bitmap = await createImageBitmap(blob);
    const dimensions = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return dimensions;
  } catch {
    return {};
  }
}

async function localImageAsset(source) {
  if (!source) return { src: source };
  if (source.startsWith("data:")) {
    const blob = await (await fetch(source)).blob();
    return { src: source, ...await imageBlobDimensions(blob) };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(source, { credentials: "include", signal: controller.signal });
    if (!response.ok) throw new Error(`Image request returned ${response.status}`);
    const blob = await response.blob();
    if (!blob.type.startsWith("image/")) throw new Error("Downloaded resource is not an image");
    return { src: await dataUrl(blob), ...await imageBlobDimensions(blob) };
  } finally {
    clearTimeout(timeout);
  }
}

async function serializablePassages(passages) {
  return Promise.all(passages.map(async (passage) => {
    const saved = structuredClone(passage);
    if (saved.image?.src && (!saved.image.src.startsWith("data:") || !(saved.image.width > 0 && saved.image.height > 0))) {
      try {
        if (/^https?:/iu.test(saved.image.src)) saved.image.originalSrc ||= saved.image.src;
        const asset = await localImageAsset(saved.image.src);
        saved.image.src = asset.src;
        saved.image.width ||= asset.width;
        saved.image.height ||= asset.height;
      } catch (error) {
        console.warn("Could not save article image locally:", saved.image.src, error);
        saved.image.src = "";
        saved.image.unavailable = true;
      }
    }
    return saved;
  }));
}

function usePersistedPassages(passages) {
  state.passages = passages.map((passage) => ({ ...passage, sentences: passageSentences(passage) }));
  [...$("#article").querySelectorAll(".passage")].forEach((element, index) => {
    const image = element.querySelector("img");
    if (!image) return;
    const source = state.passages[index]?.image?.src;
    if (source) image.src = source;
    else image.remove();
  });
}

async function persistDocument(input) {
  const saved = await saveDocument({ ...input, passages: await serializablePassages(input.passages) });
  usePersistedPassages(saved.passages || []);
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
  summaryStarted = false;
  $("#summaryPanel").hidden = false;
  $("#summaryLoading").hidden = true;
  $("#summaryText").textContent = summary.text;
  $("#summaryText").hidden = false;
  updateSummaryControls();
  return true;
}

async function setupSummarizer() {
  summaryApiSupported = "Summarizer" in globalThis;
  updateSummaryControls();
}

function updateSummaryControls() {
  const button = $("#summarize");
  const provider = $("#summaryProvider").value;
  const hasContent = documentReady && state.passages.some((passage) => passage.text || passage.type === "table");
  const supported = provider === "chrome" ? summaryApiSupported : Boolean(navigator.gpu);
  button.hidden = false;
  button.disabled = summaryStarted || !hasContent || !supported;
  if (!supported) button.textContent = provider === "chrome" ? "Chrome local API unavailable" : "WebGPU unavailable";
  else if (!$("#summaryText").hidden && $("#summaryText").textContent) button.textContent = "Regenerate local summary";
  else button.textContent = provider === "chrome" ? "Generate with local Chrome API" : "Generate with Gemma 3 WebGPU";
}

async function prepareChromeSummary() {
  if (!summaryApiSupported) throw new Error("The local Chrome Summarizer API is unavailable.");
  summaryLanguagePromise ||= detectSummaryLanguage();
  const language = await summaryLanguagePromise;
  if (!SUMMARIZER_LANGUAGES.includes(language)) throw new Error(`${language.toUpperCase()} summaries are unavailable in the Chrome local API.`);
  const availability = await Summarizer.availability({
    type: "tldr",
    format: "plain-text",
    length: "short",
    preference: CHROME_SUMMARY_PREFERENCE,
    expectedInputLanguages: [language],
    outputLanguage: language,
  });
  if (!["downloadable", "downloading", "available"].includes(availability)) {
    throw new Error(`Chrome's speed summarizer is unavailable for ${language.toUpperCase()}.`);
  }
  return language;
}

async function chromeSummarizerAvailable(length, language) {
  const availability = await Summarizer.availability({
    type: "tldr",
    format: "plain-text",
    length,
    preference: CHROME_SUMMARY_PREFERENCE,
    expectedInputLanguages: [language],
    outputLanguage: language,
  });
  return ["downloadable", "downloading", "available"].includes(availability);
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

async function persistGeneratedSummary(text, language, provider) {
  if (!activeDocumentId || !text) return;
  try {
    await updateDocumentSummary(activeDocumentId, { text, language, provider, createdAt: Date.now() });
  } catch (error) {
    console.warn("Could not persist local summary:", error);
  }
}

function showSummaryError(error) {
  summaryStarted = false;
  $("#summaryLoading").hidden = true;
  $("#summaryText").hidden = false;
  $("#summaryText").textContent = `Could not summarize locally: ${error.message}`;
  updateSummaryControls();
  setStatus({ state: "error", message: error.message });
}

async function summarizeWithChromeApi() {
  const parts = summarySourceParts();
  if (!parts.length) return;
  $("#summaryPanel").hidden = false;
  $("#summarize").hidden = true;
  $("#summaryText").hidden = true;
  $("#summaryLoading").hidden = false;
  let mapSummarizer;
  let finalSummarizer;
  try {
    const language = await prepareChromeSummary();
    const downloadProgress = (loaded) => {
      const percent = Math.round(loaded * 100);
      if (loaded < 0.99) {
        setStatus({ state: "loading", message: `Downloading summarizer · ${percent}%` });
      } else {
        setStatus({ state: "loading", message: "Summarizing with Chrome's speed model…" });
      }
    };
    finalSummarizer = await createLocalSummarizer("short", downloadProgress, language, CHROME_SUMMARY_PREFERENCE);
    let groups = await splitForQuota(parts, finalSummarizer);
    if (groups.length === 1) {
      const summary = await finalSummarizer.summarize(groups[0]);
      $("#summaryText").textContent = summary;
    } else {
      // A normal article needs only the short speed summarizer. Load the long
      // intermediate variant solely when the input exceeds that model's quota.
      mapSummarizer = await chromeSummarizerAvailable("long", language)
        ? await createLocalSummarizer("long", downloadProgress, language, CHROME_SUMMARY_PREFERENCE)
        : finalSummarizer;
      groups = await splitForQuota(parts, mapSummarizer);
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
    await persistGeneratedSummary(summaryText, language, "chrome");
    $("#summaryText").hidden = false;
    $("#summaryLoading").hidden = true;
    summaryStarted = false;
    updateSummaryControls();
    setStatus({ state: "ready", message: "Chrome speed summary ready" });
  } catch (error) {
    showSummaryError(error);
  } finally {
    if (mapSummarizer && mapSummarizer !== finalSummarizer) mapSummarizer.destroy();
    finalSummarizer?.destroy();
  }
}

// Although the model advertises a 32K context, the 270M checkpoint follows
// summarization instructions more reliably with focused source windows. This
// also bounds the WebGPU prefill/KV-cache allocation on integrated GPUs.
const GEMMA_INPUT_TOKEN_BUDGET = 3000;

async function splitOversizedGemmaPart(text, maxTokens, onProgress) {
  if (await measureGemmaTokens(text, onProgress) <= maxTokens) return [text];
  const units = sentences(text);
  if (units.length > 1) return gemmaSummaryChunks(units, maxTokens, onProgress);
  const midpoint = Math.floor(text.length / 2);
  const splitAt = text.lastIndexOf(" ", midpoint) > text.length * 0.25 ? text.lastIndexOf(" ", midpoint) : midpoint;
  return [
    ...await splitOversizedGemmaPart(text.slice(0, splitAt), maxTokens, onProgress),
    ...await splitOversizedGemmaPart(text.slice(splitAt).trim(), maxTokens, onProgress),
  ];
}

async function gemmaSummaryChunks(parts, maxTokens = GEMMA_INPUT_TOKEN_BUDGET, onProgress) {
  const chunks = [];
  let current = "";
  for (const part of parts) {
    const units = await splitOversizedGemmaPart(part, maxTokens, onProgress);
    for (const unit of units) {
      const candidate = current ? `${current}\n\n${unit}` : unit;
      if (current && await measureGemmaTokens(candidate, onProgress) > maxTokens) {
        chunks.push(current);
        current = unit;
      } else current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

async function summarizeWithGemmaModel() {
  const parts = summarySourceParts();
  if (!parts.length) return;
  if (!navigator.gpu) throw new Error("WebGPU is unavailable in this browser.");
  $("#summaryPanel").hidden = false;
  $("#summaryText").hidden = true;
  $("#summaryLoading").hidden = false;
  try {
    const progress = (event) => {
      if (event.status === "progress_total") setStatus({ state: "loading", message: `Downloading Gemma 3 270M · ${Math.round(event.progress || 0)}%` });
      else if (event.status === "generating") setStatus({ state: "loading", message: "Summarizing locally with Gemma 3…" });
    };
    let groups = await gemmaSummaryChunks(parts, GEMMA_INPUT_TOKEN_BUDGET, progress);
    let summaries = [];
    if (groups.length === 1) summaries.push(await summarizeWithGemma(groups[0], "direct", progress));
    for (let index = 0; index < groups.length; index++) {
      if (groups.length === 1) break;
      setStatus({ state: "loading", message: groups.length > 1 ? `Summarizing section ${index + 1} of ${groups.length} with Gemma 3…` : "Loading Gemma 3 locally…" });
      summaries.push(await summarizeWithGemma(groups[index], "section", progress));
    }
    let rounds = 0;
    while (summaries.length > 1 || await measureGemmaTokens(summaries[0], progress) > GEMMA_INPUT_TOKEN_BUDGET) {
      if (++rounds > 6) throw new Error("The document could not be reduced to the Gemma 3 context window.");
      groups = await gemmaSummaryChunks(summaries, GEMMA_INPUT_TOKEN_BUDGET, progress);
      if (groups.length === 1) {
        summaries = [await summarizeWithGemma(groups[0], "final", progress)];
        break;
      }
      summaries = [];
      for (const group of groups) summaries.push(await summarizeWithGemma(group, "reduction", progress));
    }
    const summaryText = summaries[0];
    const language = await (summaryLanguagePromise ||= detectSummaryLanguage());
    $("#summaryText").textContent = summaryText;
    $("#summaryText").hidden = false;
    $("#summaryLoading").hidden = true;
    await persistGeneratedSummary(summaryText, language, "gemma-3-270m-it-q4f16-webgpu");
    summaryStarted = false;
    updateSummaryControls();
    setStatus({ state: "ready", message: "Gemma 3 local AI summary ready" });
  } catch (error) {
    showSummaryError(error);
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
      summaryProvider: $("#summaryProvider").value,
    },
  });
}

async function restorePreferences() {
  const { readerPreferences = {} } = await chrome.storage.local.get("readerPreferences");
  if (["pocket", "inflect"].includes(readerPreferences.provider)) $("#provider").value = readerPreferences.provider;
  if (InflectTTS.MODELS[readerPreferences.model]) $("#model").value = readerPreferences.model;
  if (PocketTTS.VOICES.includes(readerPreferences.voice)) $("#voice").value = readerPreferences.voice;
  if ([...$("#speed").options].some((option) => option.value === readerPreferences.speed)) $("#speed").value = readerPreferences.speed;
  const savedSummaryProvider = readerPreferences.summaryProvider === "lfm" ? "gemma" : readerPreferences.summaryProvider;
  if (["chrome", "gemma"].includes(savedSummaryProvider)) $("#summaryProvider").value = savedSummaryProvider;
  inflectTts.setModel($("#model").value);
  pocketTts.setVoice($("#voice").value);
  applyProviderUI();
  updateSummaryControls();
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
  document.querySelectorAll("script, style, noscript, nav, form").forEach((element) => element.remove());
  const passages = [];
  for (const element of document.querySelectorAll("h1, h2, h3, h4, h5, h6, p, blockquote, li, pre, table, img, .comment-metadata, .comment-content")) {
    if (element.matches("img")) {
      const rawSource = element.getAttribute("src") || element.getAttribute("data-src") || element.getAttribute("data-original");
      const width = element.getAttribute("width");
      const height = element.getAttribute("height");
      if (!rawSource || (width !== null && Number(width) <= 2) || (height !== null && Number(height) <= 2)) continue;
      let src;
      try {
        const resolved = new URL(rawSource, sourceUrl);
        if (!["http:", "https:", "data:", "blob:"].includes(resolved.protocol)) continue;
        src = resolved.href;
      } catch { continue; }
      const description = (element.getAttribute("alt") || element.getAttribute("title") || "").replace(/\s+/g, " ").trim();
      const intrinsicWidth = Number.parseFloat(element.getAttribute("width"));
      const intrinsicHeight = Number.parseFloat(element.getAttribute("height"));
      passages.push({
        type: "image",
        text: description ? `Picture of ${description}` : "",
        description,
        image: {
          src,
          alt: description,
          ...(intrinsicWidth > 0 && intrinsicHeight > 0 ? { width: intrinsicWidth, height: intrinsicHeight } : {}),
        },
      });
      continue;
    }
    if (element.matches("pre")) {
      const text = element.querySelector("code")?.textContent || element.textContent || "";
      if (!text.trim()) continue;
      const code = element.querySelector("code");
      passages.push({
        type: "code",
        text,
        language: code?.getAttribute("data-lang") || code?.className.match(/(?:^|\s)language-([\w-]+)/)?.[1] || "",
      });
      continue;
    }
    if (element.matches("table")) {
      const rows = [...element.querySelectorAll("tr")].map((row) => ({
        cells: [...row.querySelectorAll(":scope > th, :scope > td")].map((cell) => ({
          text: cell.textContent.replace(/\s+/g, " ").trim(),
          header: cell.matches("th"),
        })).filter((cell) => cell.text),
      })).filter((row) => row.cells.length);
      if (rows.length) passages.push({ type: "table", text: "", table: { rows } });
      continue;
    }
    if (element.matches(".comment-metadata, .comment-content") && element.querySelector("h1, h2, h3, h4, h5, h6, p, blockquote, li, pre, table, img")) continue;
    if (element.closest("pre")) continue;
    if (element.closest("table")) continue;
    if (element.matches("blockquote") && element.querySelector("h1, h2, h3, h4, h5, h6, p, li, pre, table, img, .comment-metadata, .comment-content")) continue;
    if (element.matches("li") && element.querySelector("p, blockquote")) continue;
    const links = [...element.querySelectorAll("a[href]")].flatMap((anchor) => {
      const label = anchor.textContent.replace(/\s+/g, " ").trim();
      if (!label) return [];
      try {
        const href = new URL(anchor.getAttribute("href"), sourceUrl);
        return ["http:", "https:", "mailto:"].includes(href.protocol) ? [{ label, href: href.href }] : [];
      } catch { return []; }
    });
    const text = element.textContent
      .replace(/\s+([,.;:!?])/g, "$1")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) continue;
    passages.push({ type: element.matches("h1, h2, h3, h4, h5, h6") ? "heading" : "paragraph", text, ...(links.length ? { links } : {}) });
  }
  return passages;
}

function decorateConversationPassages(passages, siteName = "") {
  const site = String(siteName || "").trim();
  if (!/^(?:ChatGPT|Claude|Gemini|Grok)$/i.test(site)) return passages;
  const speakerPattern = /^(you|user|assistant|chatgpt|claude|gemini|grok)(?:\s+said)?$/i;
  const decorated = [];
  let role = "";
  let speaker = "";
  let group = -1;
  let firstInGroup = false;
  for (const passage of passages) {
    const label = String(passage.text || "").replace(/\s+/g, " ").trim();
    const speakerMatch = label.match(speakerPattern);
    if (["heading", "paragraph"].includes(passage.type) && speakerMatch) {
      const normalizedSpeaker = speakerMatch[1];
      speaker = /^(?:you|user)$/i.test(normalizedSpeaker) ? "You" : normalizedSpeaker === "chatgpt" ? "ChatGPT" : normalizedSpeaker[0].toUpperCase() + normalizedSpeaker.slice(1);
      role = /^(?:you|user)$/i.test(normalizedSpeaker) ? "user" : "assistant";
      group++;
      firstInGroup = true;
      continue;
    }
    if (role) {
      decorated.push({
        ...passage,
        chatRole: role,
        chatGroup: group,
        ...(firstInGroup ? { chatSpeaker: speaker } : {}),
      });
      firstInGroup = false;
    } else decorated.push(passage);
  }
  return group >= 0 ? decorated : passages;
}

function passageSentences(passage) {
  return passage.type === "code" || !passage.text ? [] : sentences(passage.text);
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
  const normalized = block ? normalizePdfTypography(String(block.text || "")) : "";
  return normalized ? extractPdfInlineStyles(normalized).text
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
      const lowerMarginNumber = block.type === "text"
        && /^(?:\d{1,4}|[ivxlcdm]{1,8})$/iu.test(String(block.text || "").trim())
        && block.layout?.pageHeight > 0
        && block.layout.y1 >= block.layout.pageHeight * 0.78;
      if (block.isPageNumber || lowerMarginNumber) continue;
      if (block.type === "table" && block.table?.rows?.length) {
        passages.push({ type: "table", text: "", table: block.table, page: page.page, layout: block.layout });
        continue;
      }
      if (block.type === "image" && block.bytes) {
        const src = URL.createObjectURL(new Blob([block.bytes], { type: block.mime || "image/png" }));
        passages.push({ type: block.latex ? "formula" : "image", text: "", latex: block.latex || "", image: { src, alt: block.label || "PDF visual", width: block.width, height: block.height }, page: page.page, layout: block.layout });
        continue;
      }
      const markedText = repairWrappedPdfUrls(normalizePdfTypography(String(block.text || "")))
        .replace(/-\uE107\s*\n\s*\uE106(?=\p{Ll})/gu, "")
        .replace(/-\n(?=\p{Ll})/gu, "")
        .replace(/\s*\n\s*/g, " ")
        .replace(/\s+([,.;:!?%)\]])/g, "$1")
        .replace(/\s+/g, " ")
        .trim();
      const { text, superscriptRanges, subscriptRanges, mathRanges, boldRanges } = extractPdfInlineStyles(markedText);
      if (!text) continue;
      const fontRatio = (block.fontSize || bodyFontSize) / bodyFontSize;
      const isTitle = block === likelyTitleBlock;
      const isHeading = isTitle || ["Title", "Section-header"].includes(block.layoutLabel)
        || (block.layoutLabel === "Text" && fontRatio >= 1.45 && text.length <= 180 && !/[.!?]$/u.test(text));
      passages.push({
        type: isHeading ? "heading" : "paragraph",
        text,
        superscriptRanges,
        subscriptRanges,
        mathRanges,
        boldRanges,
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
    let previousIndex = merged.length - 1;
    while (previousIndex >= 0 && isPdfVisualInterruption(merged[previousIndex])) previousIndex -= 1;
    const previous = merged[previousIndex];
    const crossedVisuals = previousIndex >= 0 && previousIndex < merged.length - 1;
    const adjacentPages = previous && Number.isInteger(previous.page) && Number.isInteger(passage.page)
      && passage.page >= previous.page && passage.page <= previous.page + 1;
    const sameTextFlow = previous?.type === "paragraph" && passage.type === "paragraph" && adjacentPages
      && previous.layoutLabel === "Text" && passage.layoutLabel === "Text";
    const samePage = sameTextFlow && previous.page === passage.page;
    const pageWidth = passage.layout?.pageWidth || previous?.layout?.pageWidth || 0;
    const jumpsToNextColumn = samePage && pageWidth > 0
      && passage.layout.x1 > previous.layout.x1 + pageWidth * 0.18
      && passage.layout.y1 < previous.layout.y1;
    const startsLowercase = sameTextFlow && /^(?:[“‘"']\s*)?\p{Ll}/u.test(passage.text);
    const startsCitationYear = sameTextFlow && /^(?:[\[(]\s*)?(?:19|20)\d{2}\b/u.test(passage.text)
      && /(?:\bet al\.,|[,\[(])\s*$/iu.test(previous?.text || "");
    const wrappedUrl = sameTextFlow && isWrappedPdfUrlContinuation(previous?.text || "", passage.text);
    const startsMidSentence = startsLowercase || startsCitationYear;
    const previousWithoutTrailingCitations = previous?.text.replace(/(?:\s*\[[\d,;\s-]+\])+\s*$/u, "").trim() || "";
    const previousSentenceFinished = /[.!?…:;][”’"')\]]?$/u.test(previousWithoutTrailingCitations);
    const crossesPage = sameTextFlow && passage.page === previous.page + 1;
    const sentenceContinues = wrappedUrl || startsMidSentence || !previousSentenceFinished;
    const previousWidth = previous?.layout ? previous.layout.x2 - previous.layout.x1 : 0;
    const passageWidth = passage.layout ? passage.layout.x2 - passage.layout.x1 : 0;
    const horizontalOverlap = previous?.layout && passage.layout
      ? Math.max(0, Math.min(previous.layout.x2, passage.layout.x2) - Math.max(previous.layout.x1, passage.layout.x1))
      : 0;
    const sameColumn = samePage && Math.min(previousWidth, passageWidth) > 0
      && horizontalOverlap / Math.min(previousWidth, passageWidth) >= 0.5;
    const verticalGap = samePage ? passage.layout.y1 - previous.layout.y2 : Number.POSITIVE_INFINITY;
    const nearbyInColumn = sameColumn && verticalGap >= -12
      && verticalGap <= Math.max(36, (passage.layout.pageHeight || 0) * 0.04);
    const hyphenated = /-$/u.test(previous?.text || "") && /^\p{Ll}/u.test(passage.text);
    const samePageHyphen = !crossedVisuals && samePage && sameColumn && hyphenated;
    const uninterruptedContinuation = !crossedVisuals
      && sentenceContinues && (jumpsToNextColumn || (startsMidSentence || wrappedUrl) && (nearbyInColumn || crossesPage));
    const interruptedPageHyphen = crossedVisuals && crossesPage && startsMidSentence && hyphenated;
    if (uninterruptedContinuation || interruptedPageHyphen || samePageHyphen) {
      const interruptedWord = previous.text.match(/([\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*)-$/u)?.[1] || "";
      const keepCompoundHyphen = hyphenated && (wrappedUrl || interruptedWord.includes("-"));
      const prefix = previous.text.replace(hyphenated && !keepCompoundHyphen ? /-$/u : /$/u, "");
      const separator = hyphenated || wrappedUrl ? "" : " ";
      const rangeOffset = prefix.length + separator.length;
      previous.text = `${prefix}${separator}${passage.text}`;
      previous.superscriptRanges = [
        ...(previous.superscriptRanges || []).filter((range) => range.end <= prefix.length),
        ...(passage.superscriptRanges || []).map((range) => ({ start: range.start + rangeOffset, end: range.end + rangeOffset })),
      ];
      previous.subscriptRanges = [
        ...(previous.subscriptRanges || []).filter((range) => range.end <= prefix.length),
        ...(passage.subscriptRanges || []).map((range) => ({ start: range.start + rangeOffset, end: range.end + rangeOffset })),
      ];
      previous.mathRanges = [
        ...(previous.mathRanges || []).filter((range) => range.end <= prefix.length),
        ...(passage.mathRanges || []).map((range) => ({ start: range.start + rangeOffset, end: range.end + rangeOffset })),
      ];
      previous.boldRanges = [
        ...(previous.boldRanges || []).filter((range) => range.end <= prefix.length),
        ...(passage.boldRanges || []).map((range) => ({ start: range.start + rangeOffset, end: range.end + rangeOffset })),
      ];
      previous.layout = { ...previous.layout, x2: Math.max(previous.layout.x2, passage.layout.x2), y2: Math.max(previous.layout.y2, passage.layout.y2) };
      continue;
    }
    merged.push(passage);
  }
  return merged;
}

function isWrappedPdfUrlContinuation(previous, next) {
  return /https?:$/iu.test(previous) && /^\/\/[\p{L}\p{N}]/u.test(next)
    || /https?:\/\/$/iu.test(previous) && /^[\p{L}\p{N}]/u.test(next)
    || /https?:\/\/\S+[/?#=&-]$/iu.test(previous) && /^[\p{L}\p{N}%._~-]/u.test(next)
    || /https?:\/\/\S+\.$/iu.test(previous) && /^(?:com|org|net|edu|gov|io|ai|co|dev|app)\//iu.test(next);
}

function isPdfVisualInterruption(passage) {
  if (["image", "table", "formula"].includes(passage?.type)) return true;
  if (!passage?.pdfText) return false;
  return passage.layoutLabel === "Caption"
    || /^\s*(?:Figure|Fig\.?|Table)\s+\d+[A-Za-z]?\b/iu.test(passage.text || "");
}

function extractPdfInlineStyles(markedText) {
  let text = "";
  const definitions = [
    { open: "\uE100", close: "\uE101", ranges: [], start: null },
    { open: "\uE102", close: "\uE103", ranges: [], start: null },
    { open: "\uE104", close: "\uE105", ranges: [], start: null },
    { open: "\uE106", close: "\uE107", ranges: [], start: null },
  ];
  for (const character of markedText) {
    const opening = definitions.find((definition) => definition.open === character);
    if (opening) { if (opening.start === null) opening.start = text.length; continue; }
    const closing = definitions.find((definition) => definition.close === character);
    if (closing) {
      if (closing.start !== null && text.length > closing.start) closing.ranges.push({ start: closing.start, end: text.length });
      closing.start = null;
      continue;
    }
    text += character;
  }
  for (const definition of definitions) {
    if (definition.start !== null && text.length > definition.start) definition.ranges.push({ start: definition.start, end: text.length });
  }
  return { text, superscriptRanges: definitions[0].ranges, subscriptRanges: definitions[1].ranges, mathRanges: definitions[2].ranges, boldRanges: definitions[3].ranges };
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

function removePdfTableOfContents(passages) {
  const heading = passages.find((passage) => passage.pdfText
    && Number.isInteger(passage.page)
    && /^(?:table\s+of\s+)?contents?\s*$/iu.test(String(passage.text || "").trim()));
  if (!heading) return passages;

  const startPage = heading.page;
  const lastPage = Math.max(...passages.map((passage) => Number.isInteger(passage.page) ? passage.page : 0));
  const nearbyTables = passages.filter((passage) => passage.type === "table"
    && passage.page >= startPage && passage.page <= startPage + 8);
  const destinationPages = nearbyTables.flatMap((passage) => passage.table?.rows || []).flatMap((row) => {
    const lastCell = [...(row.cells || [])].reverse().find((cell) => String(cell.text || "").trim());
    const match = String(lastCell?.text || "").trim().match(/^(\d{1,4})$/u);
    return match ? [Number(match[1])] : [];
  }).filter((page) => page > startPage && page <= lastPage);

  const firstDestination = destinationPages.length ? Math.min(...destinationPages) : null;
  let endPage = firstDestination && firstDestination <= startPage + 12 ? firstDestination - 1 : startPage;
  if (!firstDestination) {
    for (let page = startPage + 1; page <= Math.min(lastPage, startPage + 8); page++) {
      const pagePassages = passages.filter((passage) => passage.page === page);
      const tableRows = pagePassages.filter((passage) => passage.type === "table").flatMap((passage) => passage.table?.rows || []);
      const numberedRows = tableRows.filter((row) => /\d{1,4}\s*$/u.test(String(row.cells?.at(-1)?.text || "").trim()));
      const textEntries = pagePassages.filter((passage) => passage.pdfText
        && /^\s*\d+(?:\.\d+)*\s+.+?\s+\d{1,4}\s*$/u.test(String(passage.text || "")));
      const tableLooksLikeContents = tableRows.length >= 3 && numberedRows.length / tableRows.length >= 0.5;
      if (!tableLooksLikeContents && textEntries.length < 3) break;
      endPage = page;
    }
  }
  return passages.filter((passage) => !Number.isInteger(passage.page) || passage.page < startPage || passage.page > endPage);
}

function startsPdfTableOfContents(passages) {
  return passages.some((passage) => passage.pdfText
    && /^(?:table\s+of\s+)?contents?\s*$/iu.test(String(passage.text || "").trim()));
}

function pdfTableOfContentsDestinations(passages) {
  return passages.filter((passage) => passage.type === "table").flatMap((passage) => passage.table?.rows || []).flatMap((row) => {
    const lastCell = [...(row.cells || [])].reverse().find((cell) => String(cell.text || "").trim());
    const match = String(lastCell?.text || "").trim().match(/^(\d{1,4})$/u);
    return match ? [Number(match[1])] : [];
  });
}

function looksLikePdfTableOfContentsPage(passages) {
  const tableRows = passages.filter((passage) => passage.type === "table").flatMap((passage) => passage.table?.rows || []);
  const numberedRows = tableRows.filter((row) => {
    const lastCell = [...(row.cells || [])].reverse().find((cell) => String(cell.text || "").trim());
    return /^\d{1,4}$/u.test(String(lastCell?.text || "").trim());
  });
  if (tableRows.length >= 3 && numberedRows.length / tableRows.length >= 0.5) return true;
  const textEntries = passages.filter((passage) => passage.pdfText
    && /^\s*\d+(?:\.\d+)*\s+.+?\s+\d{1,4}\s*$/u.test(String(passage.text || "")));
  return textEntries.length >= 3;
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

function repairWrappedPdfUrls(value) {
  return value
    .replace(/\b(https?):\s*\/\/\s*(?=[\p{L}\p{N}])/giu, "$1://")
    .replace(/(https?:\/\/[^\s]+[/?#=&-])\s*\n\s*(?=[\p{L}\p{N}%._~-])/giu, "$1")
    .replace(/(https?:\/\/[^\s]+\.)\s*\n\s*(?=(?:com|org|net|edu|gov|io|ai|co|dev|app)\/)/giu, "$1");
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
  const punctuation = new Map([[".", "\uE200"], ["?", "\uE201"], ["!", "\uE202"]]);
  const restore = (value) => value.replace(/[\uE200-\uE202]/gu, (character) => [".", "?", "!"][character.codePointAt(0) - 0xE200]);
  const characters = text.split("");
  for (const match of linkMatches(text)) {
    for (let index = match.start; index < match.end; index++) {
      if (punctuation.has(characters[index])) characters[index] = punctuation.get(characters[index]);
    }
  }
  const segmentable = characters.join("");
  if (typeof Intl.Segmenter === "function") {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "sentence" });
    const result = [...segmenter.segment(segmentable)].map(({ segment }) => restore(segment).trim()).filter(Boolean);
    if (result.length) return result;
  }
  return segmentable.match(/[^.!?]+(?:[.!?]+|$)/g)?.map((sentence) => restore(sentence).trim()).filter(Boolean) || [text];
}

function normalizeAuthorYearKey(surname, year) {
  const author = normalizeReferenceName(surname);
  return author && year ? `${author}:${String(year).toLocaleLowerCase()}` : "";
}

function normalizeReferenceName(value) {
  return String(value || "").normalize("NFKD").replace(/\p{M}/gu, "").replace(/[^\p{L}\p{N}]+/gu, "").toLocaleLowerCase();
}

function bibliographyFirstAuthorMatches(text, normalizedSurname) {
  const beforeYear = String(text || "").split(/\b(?:19|20)\d{2}[a-z]?\b/iu, 1)[0];
  const firstAuthor = beforeYear.includes(",") ? beforeYear.slice(0, beforeYear.indexOf(",")) : beforeYear;
  return normalizeReferenceName(firstAuthor).endsWith(normalizedSurname);
}

function authorYearCitationMatches(text) {
  const source = String(text || "");
  const pattern = /\b([\p{L}\p{M}][\p{L}\p{M}'’.-]{1,})(?:\s+et\s+al\.|\s*(?:&|and)\s+[\p{L}\p{M}][\p{L}\p{M}'’.-]{1,})?(?:\s*,\s*|\s*\(\s*)((?:19|20)\d{2}[a-z]?)/giu;
  return [...source.matchAll(pattern)].map((match) => {
    const includesOpeningParenthesis = match[0].includes("(");
    const includesClosingParenthesis = includesOpeningParenthesis && source[match.index + match[0].length] === ")";
    const end = match.index + match[0].length + Number(includesClosingParenthesis);
    return {
      start: match.index,
      end,
      text: source.slice(match.index, end),
      surname: match[1],
      year: match[2],
      key: normalizeAuthorYearKey(match[1], match[2]),
    };
  });
}

function appendAuthorYearCitationText(container, text, referenceIndex) {
  let offset = 0;
  for (const match of authorYearCitationMatches(text)) {
    const reference = referenceIndex.authorYears.get(match.key);
    if (!reference) continue;
    appendLinkifiedPdfText(container, text.slice(offset, match.start));
    const link = document.createElement("a");
    link.className = "pdf-citation";
    link.href = `#${reference.id}`;
    link.textContent = match.text;
    link.title = `Jump to ${reference.label}`;
    container.append(link);
    offset = match.end;
  }
  appendLinkifiedPdfText(container, text.slice(offset));
}

function appendPdfCitationText(container, text, referenceIndex, isReferenceEntry) {
  if (isReferenceEntry) { appendLinkifiedPdfText(container, text); return; }
  const citationPattern = /\[(?:\d+\s*(?:[,;–-]\s*\d+\s*)*)\]/g;
  let offset = 0;
  for (const match of text.matchAll(citationPattern)) {
    appendAuthorYearCitationText(container, text.slice(offset, match.index), referenceIndex);
    const marker = match[0];
    let markerOffset = 0;
    for (const numberMatch of marker.matchAll(/\d+/g)) {
      container.append(document.createTextNode(marker.slice(markerOffset, numberMatch.index)));
      const number = numberMatch[0];
      if (referenceIndex.numbers.has(number)) {
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
  appendAuthorYearCitationText(container, text.slice(offset), referenceIndex);
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

function appendLinkedPassageText(container, text, links = []) {
  const matches = linkMatches(text).map((match) => ({ ...match, priority: 0 }));
  for (const link of links) {
    let offset = 0;
    while (offset < text.length) {
      const index = text.indexOf(link.label, offset);
      if (index < 0) break;
      matches.push({ start: index, end: index + link.label.length, label: link.label, href: link.href, priority: 1 });
      offset = index + link.label.length;
    }
  }
  const selected = matches.sort((left, right) => left.start - right.start || right.priority - left.priority || right.end - left.end)
    .filter((match, index, sorted) => !sorted.slice(0, index).some((earlier) => match.start < earlier.end));
  let offset = 0;
  for (const match of selected) {
    container.append(document.createTextNode(text.slice(offset, match.start)));
    const link = document.createElement("a");
    link.className = "pdf-external-link";
    link.href = match.href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = match.label;
    container.append(link);
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

function appendPdfLinkedText(container, text, referenceIndex, visuals, isReferenceEntry) {
  const pattern = /\b(Figure|Fig\.?|Table)\s+(\d+[A-Za-z]?)\b/giu;
  let offset = 0;
  for (const match of text.matchAll(pattern)) {
    appendPdfCitationText(container, text.slice(offset, match.index), referenceIndex, isReferenceEntry);
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
  appendPdfCitationText(container, text.slice(offset), referenceIndex, isReferenceEntry);
}

function appendPdfStyledText(container, text, textStart, superscriptRanges, subscriptRanges, mathRanges, boldRanges, referenceIndex, visuals, isReferenceEntry) {
  const textEnd = textStart + text.length;
  const boundaries = new Set([0, text.length]);
  for (const ranges of [superscriptRanges, subscriptRanges, mathRanges, boldRanges]) {
    for (const range of ranges || []) {
      if (range.end <= textStart || range.start >= textEnd) continue;
      boundaries.add(Math.max(0, range.start - textStart));
      boundaries.add(Math.min(text.length, range.end - textStart));
    }
  }
  const offsets = [...boundaries].sort((left, right) => left - right);
  for (let index = 0; index < offsets.length - 1; index += 1) {
    const start = offsets[index];
    const end = offsets[index + 1];
    if (end <= start) continue;
    const segment = text.slice(start, end);
    const isSuperscript = (superscriptRanges || []).some((range) => range.start <= textStart + start && range.end >= textStart + end);
    const isSubscript = (subscriptRanges || []).some((range) => range.start <= textStart + start && range.end >= textStart + end);
    const isMath = (mathRanges || []).some((range) => range.start <= textStart + start && range.end >= textStart + end);
    const isBold = (boldRanges || []).some((range) => range.start <= textStart + start && range.end >= textStart + end);
    const tags = [isSuperscript ? "sup" : isSubscript ? "sub" : "", isBold ? "strong" : "", isMath ? "var" : ""].filter(Boolean);
    let root = null;
    let target = null;
    for (const tag of tags) {
      const element = document.createElement(tag);
      if (target) target.append(element);
      else root = element;
      target = element;
    }
    appendPdfLinkedText(target || container, segment, referenceIndex, visuals, isReferenceEntry);
    if (root) container.append(root);
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
    const label = target.dataset.referenceLabel || `Reference ${hash.slice("#pdf-ref-".length)}`;
    preview.querySelector("strong").textContent = label;
    media.hidden = true;
    description.textContent = target.dataset.referencePreview || target.textContent.trim();
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

  const bibliographyIndex = passages.findIndex((passage) => passage.pdfText && bibliographyHeading.test(passage.text));
  const citedAuthorYears = new Map();
  const bodyEnd = bibliographyIndex >= 0 ? bibliographyIndex : passages.length;
  passages.slice(0, bodyEnd).forEach((passage) => {
    if (!passage.pdfText) return;
    for (const citation of authorYearCitationMatches(passage.text)) citedAuthorYears.set(citation.key, citation);
  });
  const authorYears = new Map();
  const authorYearEntries = new Map();
  if (bibliographyIndex >= 0) {
    const bibliography = passages.slice(bibliographyIndex + 1).filter((passage) => passage.pdfText && passage.text);
    for (const citation of citedAuthorYears.values()) {
      const normalizedSurname = normalizeAuthorYearKey(citation.surname, citation.year).split(":")[0];
      let matchedEntry = null;
      let previewText = "";
      for (let index = 0; index < bibliography.length && !matchedEntry; index++) {
        if (!bibliographyFirstAuthorMatches(bibliography[index].text, normalizedSurname)) continue;
        let combined = "";
        // A long author list can end one column or page before its year and
        // title. Search a small adjacent window, anchored on the block that
        // contains the cited surname, without merging the bibliography at
        // large.
        for (let lookahead = 0; lookahead < 3 && index + lookahead < bibliography.length; lookahead++) {
          combined = `${combined} ${bibliography[index + lookahead].text}`.trim();
          const year = combined.match(/\b(?:19|20)\d{2}[a-z]?\b/iu)?.[0];
          if (!year) continue;
          if (year.toLocaleLowerCase() === citation.year.toLocaleLowerCase()) {
            matchedEntry = bibliography[index];
            previewText = combined;
          }
          break;
        }
      }
      if (!matchedEntry) continue;
      const id = `pdf-ref-${citation.key.replace(":", "-")}`;
      const reference = { id, label: `Reference: ${citation.surname}, ${citation.year}`, passage: matchedEntry, previewText };
      authorYears.set(citation.key, reference);
      if (!authorYearEntries.has(matchedEntry)) authorYearEntries.set(matchedEntry, reference);
    }
  }

  return { entries, numbers: new Set(entries.values()), authorYears, authorYearEntries };
}

function preserveImageAspectRatio(image, dimensions = {}) {
  const width = Number(dimensions.width);
  const height = Number(dimensions.height);
  if (!(width > 0 && height > 0)) return;
  image.width = Math.round(width);
  image.height = Math.round(height);
  image.style.aspectRatio = `${width} / ${height}`;
  image.style.height = "auto";
}

function render(metadata, passages, sourceUrl) {
  const article = $("#article");
  activeSourceUrl = sourceUrl;
  activeMetadata = metadata;
  setupYouTubePlayer(sourceUrl);
  article.replaceChildren();
  article.classList.toggle("youtube-transcript", Boolean(youtubeIdFromUrl(sourceUrl)));
  const title = metadata.title || passages.find((passage) => passage.type === "heading")?.text || new URL(sourceUrl).hostname;
  if (!metadata.hideTitle) {
    const heading = document.createElement("h1");
    heading.textContent = title;
    article.append(heading);
  }
  const details = [metadata.author, metadata.site, metadata.published?.slice(0, 10)].filter(Boolean);
  if (details.length) { const byline = document.createElement("p"); byline.className = "byline"; byline.textContent = details.join(" · "); article.append(byline); }
  const referenceIndex = associatePdfReferences(passages);
  const visuals = associatePdfVisuals(passages);
  const chatGroups = new Map();
  article.classList.toggle("conversation-thread", passages.some((passage) => passage.chatRole));
  passages.forEach((passage, index) => {
    if (!metadata.hideTitle && index === 0 && passage.type === "heading" && passage.text === title) return;
    const element = document.createElement(passage.type === "heading" ? (passage.headingLevel === 1 ? "h1" : "h2") : ["image", "formula"].includes(passage.type) ? "figure" : passage.type === "table" ? "section" : passage.type === "code" ? "pre" : "p");
    element.className = `passage ${passage.type}`;
    if (passage.pdfText) {
      element.classList.add("pdf-text");
      element.classList.toggle("pdf-title", passage.headingLevel === 1);
      element.classList.toggle("pdf-bold", Boolean(passage.isBold));
      element.classList.toggle("pdf-italic", Boolean(passage.isItalic));
    }
    element.dataset.index = index;
    const referenceNumber = referenceIndex.entries.get(passage) || null;
    const authorYearReference = referenceIndex.authorYearEntries.get(passage) || null;
    if (referenceNumber) {
      element.id = `pdf-ref-${referenceNumber}`;
      element.dataset.referenceLabel = `Reference ${referenceNumber}`;
    } else if (authorYearReference) {
      element.id = authorYearReference.id;
      element.dataset.referenceLabel = authorYearReference.label;
      element.dataset.referencePreview = authorYearReference.previewText;
    }
    if (passage.figureNumber) element.id = `pdf-figure-${passage.figureNumber}`;
    if (passage.tableNumber) element.id = `pdf-table-${passage.tableNumber}`;
    if (passage.visualCaption) element.dataset.previewCaption = passage.visualCaption;
    if (passage.type === "code") {
      const code = document.createElement("code");
      if (passage.language) { code.className = `language-${passage.language}`; code.dataset.lang = passage.language; }
      code.textContent = passage.text;
      element.append(code);
    } else if (passage.type === "table") {
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
    } else if (passage.type === "formula") {
      element.classList.add("formula");
      const renderedMath = renderMath(passage.latex);
      if (renderedMath) {
        const math = document.createElement("div");
        math.className = "math-render";
        math.innerHTML = renderedMath;
        math.title = passage.latex;
        element.append(math);
      } else if (passage.image?.src) {
        const image = document.createElement("img");
        image.className = "formula-image-fallback";
        image.src = passage.image.src;
        image.alt = "Formula from the original PDF";
        image.loading = "lazy";
        preserveImageAspectRatio(image, passage.image);
        element.append(image);
      }
    } else if (passage.type === "image") {
      const image = document.createElement("img");
      image.src = passage.image.src;
      image.alt = passage.image.alt || "";
      image.loading = "lazy";
      preserveImageAspectRatio(image, passage.image);
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
        appendPdfStyledText(span, sentence, Math.max(0, sentenceTextOffset), passage.superscriptRanges, passage.subscriptRanges, passage.mathRanges, passage.boldRanges, referenceIndex, visuals, Boolean(referenceNumber || authorYearReference));
        passageTextOffset = Math.max(passageTextOffset, sentenceTextOffset + sentence.length);
      }
      else appendLinkedPassageText(span, sentence, passage.links);
      element.append(span);
    });
    if (passage.chatRole) {
      let message = chatGroups.get(passage.chatGroup);
      if (!message) {
        message = document.createElement("section");
        message.className = `chat-bubble chat-bubble-${passage.chatRole}`;
        if (passage.chatSpeaker) {
          const label = document.createElement("span");
          label.className = "chat-speaker";
          label.textContent = passage.chatSpeaker;
          message.append(label);
        }
        chatGroups.set(passage.chatGroup, message);
        article.append(message);
      }
      message.append(element);
    } else article.append(element);
  });
}

function safePdfFilename(value) {
  const name = String(value || "article").normalize("NFKC")
    .replace(/[\\/:*?"<>|\u0000-\u001F]/g, " ")
    .replace(/\s+/g, " ").trim().slice(0, 120);
  return `${name || "article"}.pdf`;
}

function safeMarkdownFilename(value) {
  return safePdfFilename(value).replace(/\.pdf$/u, ".md");
}

function currentArticleMarkdown() {
  const summary = $("#summaryText");
  return articleToMarkdown({
    metadata: activeMetadata,
    sourceUrl: activeSourceUrl,
    summary: summary.hidden ? "" : summary.textContent,
    passages: state.passages,
    formulaIsValid: (latex) => Boolean(renderMath(latex)),
  });
}

function downloadCurrentArticleMarkdown() {
  const title = activeMetadata.title || $("#article h1")?.textContent || "Article";
  const blob = new Blob([currentArticleMarkdown()], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const download = document.createElement("a");
  download.href = url;
  download.download = safeMarkdownFilename(title);
  document.body.append(download);
  download.click();
  download.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  setStatus({ state: "ready", message: "Markdown exported locally" });
}

async function writeClipboardText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.append(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    textarea.remove();
    if (!copied) throw new Error("Clipboard access was denied.");
  }
}

async function copyCurrentArticleMarkdown() {
  const button = $("#copyMarkdown");
  const previousLabel = button.textContent;
  button.disabled = true;
  try {
    await writeClipboardText(currentArticleMarkdown());
    button.textContent = "Copied";
    setStatus({ state: "ready", message: "Article copied as Markdown" });
  } catch (error) {
    setStatus({ state: "error", message: `Could not copy Markdown: ${error.message}` });
  } finally {
    setTimeout(() => {
      button.textContent = previousLabel;
      button.disabled = !documentReady;
    }, 1200);
  }
}

function enableExportButtons() {
  for (const selector of ["#exportPdf", "#exportMarkdown", "#copyMarkdown"]) $(selector).disabled = false;
}

function unwrapExportSentences(container) {
  container.querySelectorAll(".sentence").forEach((sentence) => {
    sentence.replaceWith(...sentence.childNodes);
  });
}

async function waitForExportImages(container) {
  await Promise.all([...container.querySelectorAll("img")].map(async (image) => {
    if (image.complete) return;
    try {
      await Promise.race([
        image.decode(),
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]);
    } catch {}
  }));
}

function preserveExportImageRatios(container) {
  for (const image of container.querySelectorAll("img")) {
    const width = Number(image.getAttribute("width")) || image.naturalWidth;
    const height = Number(image.getAttribute("height")) || image.naturalHeight;
    preserveImageAspectRatio(image, { width, height });
  }
}

async function localizeExportImages(container) {
  await Promise.all([...container.querySelectorAll("img")].map(async (image) => {
    if (!image.src || image.src.startsWith("data:")) return;
    try {
      const asset = await localImageAsset(image.src);
      image.src = asset.src;
      preserveImageAspectRatio(image, asset);
    } catch (error) {
      console.warn("Omitting an image that could not be prepared for PDF export:", image.src, error);
      image.remove();
    }
  }));
}

function legacyCssColors(value) {
  return String(value || "").replace(/color\((?:srgb|display-p3)\s+([\d.]+%?)\s+([\d.]+%?)\s+([\d.]+%?)(?:\s*\/\s*([\d.]+%?))?\)/giu, (_, red, green, blue, alpha = "1") => {
    const channel = (part) => part.endsWith("%")
      ? Math.round(Math.min(100, Number.parseFloat(part)) * 2.55)
      : Math.round(Math.min(1, Number.parseFloat(part)) * 255);
    const opacity = alpha.endsWith("%")
      ? Math.min(100, Number.parseFloat(alpha)) / 100
      : Math.min(1, Number.parseFloat(alpha));
    return opacity < 1
      ? `rgba(${channel(red)}, ${channel(green)}, ${channel(blue)}, ${opacity})`
      : `rgb(${channel(red)}, ${channel(green)}, ${channel(blue)})`;
  });
}

function flattenExportColors(container) {
  const properties = [
    "color", "backgroundColor", "borderTopColor", "borderRightColor", "borderBottomColor",
    "borderLeftColor", "outlineColor", "textDecorationColor", "boxShadow", "textShadow",
  ];
  for (const element of [container, ...container.querySelectorAll("*")]) {
    const computed = getComputedStyle(element);
    for (const property of properties) {
      const value = computed[property];
      if (value?.includes("color(")) element.style[property] = legacyCssColors(value);
    }
  }
}

function withTimeout(promise, milliseconds, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(message)), milliseconds)),
  ]);
}

async function exportCurrentArticle() {
  const button = $("#exportPdf");
  button.disabled = true;
  const previousLabel = button.textContent;
  button.textContent = "Preparing PDF…";
  setStatus({ state: "loading", message: "Preparing PDF locally…" });
  const exportRoot = document.createElement("section");
  exportRoot.className = "pdf-export-document";
  try {
    const title = activeMetadata.title || $("#article h1")?.textContent || "Article";
    const heading = document.createElement("h1");
    heading.textContent = title;
    exportRoot.append(heading);

    const details = [activeMetadata.author, activeMetadata.site, activeMetadata.published?.slice(0, 10)].filter(Boolean);
    if (details.length) {
      const byline = document.createElement("p");
      byline.className = "pdf-export-byline";
      byline.textContent = details.join(" · ");
      exportRoot.append(byline);
    }
    const source = document.createElement("a");
    source.className = "pdf-export-source";
    source.href = activeSourceUrl;
    source.textContent = activeSourceUrl;
    exportRoot.append(source);

    const summary = $("#summaryText");
    if (!summary.hidden && summary.textContent && !/^Could not summarize locally:/u.test(summary.textContent)) {
      const summarySection = document.createElement("section");
      summarySection.className = "pdf-export-summary";
      const summaryHeading = document.createElement("h2");
      summaryHeading.textContent = "Local AI summary";
      const summaryText = document.createElement("p");
      summaryText.textContent = summary.textContent;
      summarySection.append(summaryHeading, summaryText);
      exportRoot.append(summarySection);
    }

    const article = $("#article").cloneNode(true);
    article.removeAttribute("aria-live");
    article.querySelector(".byline")?.remove();
    const duplicateTitle = article.querySelector("h1");
    if (duplicateTitle?.textContent.trim() === title.trim()) duplicateTitle.remove();
    article.querySelectorAll(".current, .done, .reference-flash").forEach((element) => element.classList.remove("current", "done", "reference-flash"));
    unwrapExportSentences(article);
    exportRoot.append(article);
    document.body.append(exportRoot);
    await document.fonts.ready;
    flattenExportColors(exportRoot);
    await localizeExportImages(exportRoot);
    await waitForExportImages(exportRoot);
    preserveExportImageRatios(exportRoot);
    const blob = await withTimeout(
      renderArticlePdf(exportRoot),
      120000,
      "The PDF renderer took too long.",
    );
    if (!(blob instanceof Blob) || !blob.size) throw new Error("The PDF renderer returned an empty document.");
    const url = URL.createObjectURL(blob);
    const download = document.createElement("a");
    download.href = url;
    download.download = safePdfFilename(title);
    document.body.append(download);
    download.click();
    download.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    setStatus({ state: "ready", message: "PDF exported locally" });
  } catch (error) {
    console.error("PDF export failed:", error);
    setStatus({ state: "error", message: `PDF export failed: ${error.message}` });
  } finally {
    exportRoot.remove();
    button.textContent = previousLabel;
    button.disabled = !documentReady;
  }
}

function markCurrent(index, sentenceIndex = 0, scroll = true) {
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
  if (scroll) document.querySelector(`.passage[data-index="${index}"] .sentence[data-sentence="${sentenceIndex}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
}

async function readArticle() {
  if (state.reading) return;
  if (state.index >= state.passages.length) { state.index = 0; state.sentence = 0; }
  if (youtubeIdFromUrl(activeSourceUrl)) {
    const exactStart = state.passages[state.index]?.youtubeSentenceStarts?.[state.sentence];
    const nextStart = youtubeTimeline().find(({ passageIndex, sentenceIndex }) =>
      passageIndex > state.index || (passageIndex === state.index && sentenceIndex >= state.sentence))?.start;
    const start = Number.isFinite(exactStart) ? exactStart
      : Number.isFinite(nextStart) ? nextStart
        : youtubeClockSeconds * 1000;
    await playYouTubeAt(start);
    return;
  }
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
  if (youtubeIdFromUrl(activeSourceUrl)) {
    state.run++;
    state.reading = false;
    state.index = index;
    state.sentence = sentenceIndex;
    inflectTts.stop();
    pocketTts.stop();
    markCurrent(index, sentenceIndex);
    if (Number.isFinite(youtubeStart)) void playYouTubeAt(youtubeStart);
    else setStatus({ state: "error", message: "This transcript sentence has no video timestamp. Reopen the YouTube video to refresh its transcript." });
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

function youtubeIdFromUrl(sourceUrl) {
  try {
    const url = new URL(sourceUrl);
    if (url.hostname === "youtu.be") return url.pathname.split("/").filter(Boolean)[0] || "";
    if (/^(?:www\.|m\.)?youtube\.com$/i.test(url.hostname)) {
      return url.searchParams.get("v") || url.pathname.match(/^\/(?:shorts|embed)\/([^/?#]+)/)?.[1] || "";
    }
  } catch {}
  return "";
}

function setupYouTubePlayer(sourceUrl) {
  const panel = $("#youtubePlayerPanel");
  const iframe = $("#youtubePlayer");
  const videoId = youtubeIdFromUrl(sourceUrl);
  stopYouTubeSync();
  youtubeTimelineCache = null;
  youtubeHighlightedPosition = "";
  youtubeClockSeconds = 0;
  youtubeClockUpdatedAt = 0;
  youtubeClockPlaying = false;
  panel.hidden = !videoId;
  if (!videoId) {
    iframe.removeAttribute("src");
    youtubePlayerLoaded = null;
    return;
  }
  if (iframe.dataset.videoId === videoId) return;
  iframe.dataset.videoId = videoId;
  youtubePlayerLoaded = new Promise((resolve) => iframe.addEventListener("load", () => {
    listenToYouTubePlayer();
    resolve();
  }, { once: true }));
  const parameters = new URLSearchParams({
    enablejsapi: "1",
    playsinline: "1",
    rel: "0",
    // The JS API validates postMessage against the real embedding origin.
    // Client identity itself is supplied separately by the scoped Referer rule.
    origin: location.origin,
    widget_referrer: YOUTUBE_APP_IDENTITY,
  });
  iframe.referrerPolicy = "strict-origin-when-cross-origin";
  iframe.src = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(videoId)}?${parameters}`;
}

function postToYouTubePlayer(message) {
  $("#youtubePlayer").contentWindow?.postMessage(JSON.stringify(message), "https://www.youtube-nocookie.com");
}

function listenToYouTubePlayer() {
  postToYouTubePlayer({ event: "listening", id: "readability-reader" });
}

function youtubeTimeline() {
  youtubeTimelineCache ||= state.passages.flatMap((passage, passageIndex) =>
    (passage.youtubeSentenceStarts || []).map((start, sentenceIndex) => ({ start, passageIndex, sentenceIndex })))
    .filter(({ start }) => Number.isFinite(start))
    .sort((left, right) => left.start - right.start);
  return youtubeTimelineCache;
}

function syncYouTubeTranscript(seconds) {
  const milliseconds = seconds * 1000;
  const timeline = youtubeTimeline();
  let low = 0;
  let high = timeline.length - 1;
  let match = null;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (timeline[middle].start <= milliseconds + 120) {
      match = timeline[middle];
      low = middle + 1;
    } else high = middle - 1;
  }
  if (!match) return;
  const position = `${match.passageIndex}:${match.sentenceIndex}`;
  if (position === youtubeHighlightedPosition) return;
  youtubeHighlightedPosition = position;
  state.index = match.passageIndex;
  state.sentence = match.sentenceIndex;
  markCurrent(match.passageIndex, match.sentenceIndex, false);
}

function requestYouTubeCurrentTime() {
  postToYouTubePlayer({ event: "command", func: "getCurrentTime", args: [] });
}

function updateYouTubeClock(seconds, playing = youtubeClockPlaying) {
  if (Number.isFinite(seconds)) youtubeClockSeconds = Math.max(0, seconds);
  youtubeClockUpdatedAt = performance.now();
  youtubeClockPlaying = playing;
}

function youtubeSyncTick() {
  requestYouTubeCurrentTime();
  if (!youtubeClockPlaying || !youtubeClockUpdatedAt) return;
  syncYouTubeTranscript(youtubeClockSeconds + (performance.now() - youtubeClockUpdatedAt) / 1000);
}

function startYouTubeSync() {
  if (!youtubeClockPlaying) updateYouTubeClock(youtubeClockSeconds, true);
  if (youtubeSyncTimer) return;
  listenToYouTubePlayer();
  youtubeSyncTick();
  youtubeSyncTimer = setInterval(youtubeSyncTick, 200);
}

function stopYouTubeSync() {
  if (youtubeClockPlaying && youtubeClockUpdatedAt) {
    youtubeClockSeconds += (performance.now() - youtubeClockUpdatedAt) / 1000;
    youtubeClockUpdatedAt = performance.now();
  }
  youtubeClockPlaying = false;
  if (!youtubeSyncTimer) return;
  clearInterval(youtubeSyncTimer);
  youtubeSyncTimer = null;
}

window.addEventListener("message", (event) => {
  const iframe = $("#youtubePlayer");
  if (event.source !== iframe.contentWindow || !/^https:\/\/(?:www\.)?youtube(?:-nocookie)?\.com$/u.test(event.origin)) return;
  let message = event.data;
  if (typeof message === "string") {
    try { message = JSON.parse(message); } catch { return; }
  }
  if (!["infoDelivery", "initialDelivery"].includes(message?.event)) return;
  const info = message.info || {};
  if (Number.isFinite(info.currentTime)) {
    updateYouTubeClock(info.currentTime);
    syncYouTubeTranscript(info.currentTime);
  }
  if (info.playerState === 1) startYouTubeSync();
  else if ([0, 2].includes(info.playerState)) stopYouTubeSync();
  if (info.playerState === 1) {
    $("#play").disabled = true;
    $("#stop").disabled = false;
  } else if ([0, 2].includes(info.playerState)) {
    $("#play").disabled = false;
    $("#play span").textContent = info.playerState === 0 ? "Replay video" : "Continue reading";
    $("#stop").disabled = true;
  }
});

function preparedYouTubePassages(article, sourceUrl) {
  let paragraphIndex = 0;
  return htmlPassages(article.content, sourceUrl).map((passage) => {
    const prepared = { ...passage, sentences: passageSentences(passage) };
    if (passage.type === "paragraph") prepared.youtubeSentenceStarts = article.paragraphSentenceStarts?.[paragraphIndex++] || [];
    return prepared;
  });
}

function hasYouTubeSentenceTimestamps(passages) {
  return passages.some((passage) => passage.youtubeSentenceStarts?.some(Number.isFinite));
}

async function playYouTubeAt(milliseconds) {
  try {
    const seconds = Math.max(0, milliseconds / 1000);
    const iframe = $("#youtubePlayer");
    if (!iframe.dataset.videoId) setupYouTubePlayer(activeSourceUrl);
    if (!iframe.dataset.videoId) throw new Error("This YouTube video could not be embedded.");
    await youtubePlayerLoaded;
    const targetOrigin = "https://www.youtube-nocookie.com";
    listenToYouTubePlayer();
    iframe.contentWindow.postMessage(JSON.stringify({ event: "command", func: "seekTo", args: [seconds, true] }), targetOrigin);
    iframe.contentWindow.postMessage(JSON.stringify({ event: "command", func: "playVideo", args: [] }), targetOrigin);
    updateYouTubeClock(seconds, true);
    syncYouTubeTranscript(seconds);
    startYouTubeSync();
    $("#play").disabled = true;
    $("#stop").disabled = false;
    setStatus({ state: "ready", message: `Playing embedded video from ${formatVideoTime(milliseconds)}` });
  } catch (error) {
    setStatus({ state: "error", message: `Could not play the embedded video: ${error.message}` });
  }
}

function stopReading() {
  state.run++;
  state.reading = false;
  inflectTts.stop();
  pocketTts.stop();
  if (youtubeIdFromUrl(activeSourceUrl)) {
    postToYouTubePlayer({ event: "command", func: "pauseVideo", args: [] });
    stopYouTubeSync();
  }
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
    const needsImageMigration = (saved.passages || []).some((passage) => passage.image?.src
      && (!passage.image.src.startsWith("data:") || !(passage.image.width > 0 && passage.image.height > 0)));
    if (needsImageMigration) {
      saved.passages = await serializablePassages(saved.passages);
      await saveDocument(saved);
    }
    const savedVideoId = saved.videoId || youtubeIdFromUrl(saved.sourceUrl);
    if (savedVideoId && !hasYouTubeSentenceTimestamps(saved.passages || [])) {
      try {
        setStatus({ state: "loading", message: "Refreshing YouTube sentence timestamps…" });
        const refreshedArticle = youtubeTranscriptArticle(await getLocalYouTubeTranscript(savedVideoId), saved.sourceUrl);
        saved.passages = preparedYouTubePassages(refreshedArticle, saved.sourceUrl);
        saved.videoId = refreshedArticle.videoId;
        saved.duration = refreshedArticle.duration;
        saved.chapters = refreshedArticle.chapters;
        saved.metadata = {
          ...saved.metadata,
          title: refreshedArticle.title,
          author: refreshedArticle.byline,
          site: refreshedArticle.siteName,
          published: refreshedArticle.publishedTime,
        };
        await saveDocument(saved);
      } catch (error) {
        console.warn("Could not refresh saved YouTube timestamps:", error);
      }
    }
    state.language = saved.language || "";
    summaryLanguagePromise = null;
    state.passages = decorateConversationPassages(saved.passages || [], saved.metadata?.site)
      .map((passage) => ({ ...passage, sentences: passageSentences(passage) }));
    if (!state.passages.length) throw new Error("This saved document contains no readable text.");
    $("#sourceLink").href = saved.sourceUrl;
    try { $("#sourceLink").textContent = saved.kind === "pdf" ? (saved.metadata?.displayTitle || "PDF document") : new URL(saved.sourceUrl).hostname; }
    catch { $("#sourceLink").textContent = saved.metadata?.displayTitle || "Saved document"; }
    $("#reprocessPdf").hidden = saved.kind !== "pdf";
    render(saved.metadata || {}, state.passages, saved.sourceUrl);
    $("#play").disabled = !state.passages.some((passage) => passage.sentences.length);
    documentReady = true;
    enableExportButtons();
    if (!restoreSavedSummary(saved.summary)) updateSummaryControls();
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
    let streamingTableOfContents = false;
    let streamingContentsDestination = null;
    const extracted = await fetchPdf(pdfUrl, (page, pageCount) => {
      const rawPassages = pdfBlockPassages([page]);
      if (startsPdfTableOfContents(rawPassages)) {
        streamingTableOfContents = true;
        const destinations = pdfTableOfContentsDestinations(rawPassages)
          .filter((destination) => destination > page.page && destination <= page.page + 12);
        streamingContentsDestination = destinations.length ? Math.min(...destinations) : null;
      }
      const reachedDestination = streamingContentsDestination && page.page >= streamingContentsDestination;
      const suppressPage = streamingTableOfContents && !reachedDestination
        && (startsPdfTableOfContents(rawPassages) || looksLikePdfTableOfContentsPage(rawPassages));
      if (!suppressPage) {
        streamingTableOfContents = false;
        streamingContentsDestination = null;
        state.passages.push(...rawPassages.map((passage) => ({ ...passage, sentences: passageSentences(passage) })));
      }
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
      state.passages = rawPassages.map((passage) => ({ ...passage, sentences: passageSentences(passage) }));
    }
    if (extracted.format === "blocks") {
      state.passages = mergePdfColumnContinuations(removePdfTableOfContents(removeRepeatedPdfMarginals(state.passages)))
        .map((passage) => ({ ...passage, sentences: passageSentences(passage) }));
    }
    if (!state.passages.length) throw new Error("This PDF contains no extractable text. Scanned PDFs require OCR.");
    render(metadata, state.passages, pdfUrl);
    $("#play").disabled = false;
    documentReady = true;
    enableExportButtons();
    await persistDocument({ kind: "pdf", sourceUrl: pdfUrl, metadata, passages: state.passages, language: state.language, pageCount: extracted.pageCount, summary: null, embeddingChunks: null });
    updateSummaryControls();
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
  state.passages = article.kind === "youtube"
    ? preparedYouTubePassages(article, sourceUrl)
    : decorateConversationPassages(htmlPassages(article.content, sourceUrl), article.siteName)
      .map((passage) => ({ ...passage, sentences: passageSentences(passage) }));
  if (!state.passages.length) throw new Error("No readable article text was found.");
  render(metadata, state.passages, sourceUrl);
  $("#play").disabled = false;
  documentReady = true;
  enableExportButtons();
  await persistDocument({ kind: article.kind === "youtube" ? "youtube" : "article", sourceUrl, metadata, passages: state.passages, language: state.language, summary: null, videoId: article.videoId, duration: article.duration, chapters: article.chapters });
  updateSummaryControls();
  setStatus({ state: "ready", message: `${state.passages.length} passages ready · saved locally` });
}

$("#play").addEventListener("click", readArticle);
$("#stop").addEventListener("click", stopReading);
$("#exportPdf").addEventListener("click", () => { void exportCurrentArticle(); });
$("#exportMarkdown").addEventListener("click", downloadCurrentArticleMarkdown);
$("#copyMarkdown").addEventListener("click", () => { void copyCurrentArticleMarkdown(); });
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
  updateSummaryControls();
  if ($("#summaryProvider").value === "gemma") void summarizeWithGemmaModel();
  else void summarizeWithChromeApi();
});
$("#summaryProvider").addEventListener("change", () => {
  updateSummaryControls();
  void savePreferences();
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
    clearGemmaSummarizer();
    await Promise.all([inflectTts.clearCache(), pocketTts.clearCache(), caches.delete("transformers-cache")]);
    setStatus({ state: "ready", message: "All cached models and voices cleared" });
  } catch (error) {
    setStatus({ state: "error", message: error.message });
  } finally {
    button.disabled = false;
  }
});
$("#article").addEventListener("click", (event) => {
  const selection = window.getSelection();
  if (selection && !selection.isCollapsed && selection.toString().trim()) return;
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
  if (!sentence) return;
  readFromPosition(Number(passage.dataset.index), Number(sentence.dataset.sentence));
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
