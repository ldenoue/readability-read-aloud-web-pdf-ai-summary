import { create, insert, search as oramaSearch } from "@orama/orama";
import { documentText, embeddingTexts, listDocuments, removeDocument, clearDocuments, updateDocumentEmbeddings } from "./library-store.js";
import { embedTexts } from "./embedding-client.js";

const $ = (selector) => document.querySelector(selector);
let library = [];
let searchIndex;
let searchRun = 0;
let timer;
const initialQuery = new URLSearchParams(location.search).get("q") || "";
$("#search").value = initialQuery;

function titleOf(savedDocument) {
  if (savedDocument.metadata?.title) return savedDocument.metadata.title;
  try { return decodeURIComponent(new URL(savedDocument.sourceUrl).pathname.split("/").pop() || new URL(savedDocument.sourceUrl).hostname).replace(/\.pdf$/i, ""); }
  catch { return "Saved document"; }
}

async function createIndex(includeVectors = false) {
  const index = await create({
    schema: {
      id: "string",
      documentId: "string",
      title: "string",
      url: "string",
      content: "string",
      embedding: "vector[384]",
    },
  });
  for (const savedDocument of library) {
    const searchableTexts = embeddingTexts(savedDocument, 1200, Number.MAX_SAFE_INTEGER);
    const chunks = searchableTexts.map((text, indexNumber) => ({
      text,
      vector: includeVectors ? savedDocument.embeddingChunks?.[indexNumber]?.vector : null,
    }));
    for (let indexNumber = 0; indexNumber < chunks.length; indexNumber++) {
      const chunk = chunks[indexNumber];
      const record = {
        id: `${savedDocument.id}:${indexNumber}`,
        documentId: savedDocument.id,
        title: titleOf(savedDocument),
        url: savedDocument.sourceUrl || "",
        content: chunk.text,
      };
      if (includeVectors && chunk.vector) record.embedding = chunk.vector;
      await insert(index, record);
    }
  }
  return index;
}

function queryTerms(query) {
  return [...new Set(query.normalize("NFKC").match(/[\p{L}\p{N}]+/gu) || [])]
    .filter((term) => term.length >= 2)
    .sort((left, right) => right.length - left.length);
}

function passageSnippet(savedDocument, hit, query) {
  let text = String(hit?.document?.content || savedDocument.summary?.text || documentText(savedDocument)).replace(/\s+/g, " ").trim();
  const title = titleOf(savedDocument).replace(/\s+/g, " ").trim();
  if (title && text.startsWith(`${title} `)) text = text.slice(title.length + 1);
  const lower = text.toLocaleLowerCase();
  const positions = queryTerms(query).map((term) => lower.indexOf(term.toLocaleLowerCase())).filter((position) => position >= 0);
  let start = positions.length ? Math.max(0, Math.min(...positions) - 110) : 0;
  if (start > 0) start = text.indexOf(" ", start) + 1 || start;
  let end = Math.min(text.length, start + 360);
  if (end < text.length) end = text.lastIndexOf(" ", end) > start ? text.lastIndexOf(" ", end) : end;
  return `${start ? "…" : ""}${text.slice(start, end).trim()}${end < text.length ? "…" : ""}`;
}

function appendHighlightedText(container, text, query) {
  const terms = queryTerms(query).map((term) => term.replace(/[\\^$.*+?()[\]{}|\-]/g, "\\$&"));
  if (!terms.length) { container.textContent = text; return; }
  const pattern = new RegExp(`(${terms.join("|")})`, "giu");
  let offset = 0;
  for (const match of text.matchAll(pattern)) {
    container.append(document.createTextNode(text.slice(offset, match.index)));
    const mark = document.createElement("mark");
    mark.textContent = match[0];
    container.append(mark);
    offset = match.index + match[0].length;
  }
  container.append(document.createTextNode(text.slice(offset)));
}

function matchReason(savedDocument, hit, query, semanticOnly) {
  if (semanticOnly) return "Semantic passage";
  const terms = queryTerms(query).map((term) => term.toLocaleLowerCase());
  const includesTerm = (value) => terms.some((term) => String(value || "").toLocaleLowerCase().includes(term));
  if (includesTerm(titleOf(savedDocument))) return "Title match";
  if (includesTerm(savedDocument.sourceUrl)) return "Address match";
  if (includesTerm(hit?.document?.content)) return "Passage match";
  return "Related passage";
}

function render(savedDocuments, query = "", matches = new Map(), semanticOnly = new Set()) {
  const results = $("#results");
  results.replaceChildren();
  $("#resultsHeading").textContent = query ? "Search results" : "Recently viewed";
  $("#empty").hidden = savedDocuments.length > 0;
  for (const savedDocument of savedDocuments) {
    const card = document.createElement("a");
    card.className = "card";
    card.href = `reader.html?doc=${encodeURIComponent(savedDocument.id)}`;
    const heading = document.createElement("h3");
    heading.textContent = titleOf(savedDocument);
    const meta = document.createElement("div");
    meta.className = "meta";
    let hostname = savedDocument.sourceUrl;
    try { hostname = new URL(savedDocument.sourceUrl).hostname || "Local file"; } catch {}
    meta.innerHTML = `<span class="kind"></span> · <span class="host"></span> · <span class="date"></span>`;
    meta.querySelector(".kind").textContent = savedDocument.kind === "pdf" ? "PDF" : savedDocument.kind === "youtube" ? "YouTube" : "Article";
    meta.querySelector(".host").textContent = hostname;
    meta.querySelector(".date").textContent = new Date(savedDocument.lastViewedAt || savedDocument.updatedAt).toLocaleDateString();
    const excerpt = document.createElement("p");
    excerpt.className = "excerpt";
    const hit = matches.get(savedDocument.id);
    if (query && hit) {
      const reason = document.createElement("div");
      reason.className = "match-reason";
      reason.textContent = matchReason(savedDocument, hit, query, semanticOnly.has(savedDocument.id));
      card.append(heading, meta, reason);
      appendHighlightedText(excerpt, passageSnippet(savedDocument, hit, query), query);
    } else {
      excerpt.textContent = (savedDocument.summary?.text || documentText(savedDocument)).slice(0, 280);
      card.append(heading, meta);
    }
    const remove = document.createElement("button");
    remove.className = "delete";
    remove.type = "button";
    remove.title = "Remove from library";
    remove.setAttribute("aria-label", `Remove ${titleOf(savedDocument)} from library`);
    remove.textContent = "×";
    remove.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!confirm(`Remove “${titleOf(savedDocument)}” from this device?`)) return;
      await removeDocument(savedDocument.id);
      library = library.filter((item) => item.id !== savedDocument.id);
      searchIndex = await createIndex();
      $("#clearLibrary").hidden = library.length === 0;
      void runSearch();
    });
    card.append(excerpt, remove);
    results.append(card);
  }
}

async function ensureEmbeddings(savedDocument, run) {
  if (savedDocument.embeddingChunks?.length) return savedDocument.embeddingChunks;
  const texts = embeddingTexts(savedDocument);
  if (!texts.length || run !== searchRun) return [];
  const vectors = await embedTexts(texts, (progress) => {
    if (run !== searchRun || progress?.status !== "progress") return;
    const percent = Number.isFinite(progress.progress) ? ` · ${Math.round(progress.progress)}%` : "";
    $("#status").textContent = `Downloading local semantic search model${percent}`;
  });
  const chunks = texts.map((text, index) => ({ text, vector: vectors[index] }));
  savedDocument.embeddingChunks = chunks;
  await updateDocumentEmbeddings(savedDocument.id, chunks);
  return chunks;
}

function documentsFromHits(hits) {
  const bestHits = new Map();
  for (const hit of hits) {
    const previous = bestHits.get(hit.document.documentId);
    if (!previous || hit.score > previous.score) bestHits.set(hit.document.documentId, hit);
  }
  const documents = library.filter((savedDocument) => bestHits.has(savedDocument.id))
    .sort((left, right) => bestHits.get(right.id).score - bestHits.get(left.id).score);
  return { documents, bestHits };
}

async function runSearch() {
  const run = ++searchRun;
  const query = $("#search").value.trim();
  const nextUrl = query ? `library.html?q=${encodeURIComponent(query)}` : "library.html";
  history.replaceState(null, "", nextUrl);
  if (!query) {
    render(library);
    $("#status").textContent = `${library.length} locally saved document${library.length === 1 ? "" : "s"}`;
    return;
  }
  const textResults = await oramaSearch(searchIndex, {
    term: query,
    mode: "fulltext",
    properties: ["title", "url", "content"],
    boost: { title: 3, url: 2 },
    tolerance: 1,
    limit: 100,
  });
  const lexical = documentsFromHits(textResults.hits);
  render(lexical.documents, query, lexical.bestHits);
  $("#status").textContent = `Searching ${library.length} local documents…`;
  try {
    const [queryVector] = await embedTexts([query]);
    for (const savedDocument of library) {
      if (run !== searchRun) return;
      await ensureEmbeddings(savedDocument, run);
    }
    if (run !== searchRun) return;
    searchIndex = await createIndex(true);
    const hybridResults = await oramaSearch(searchIndex, {
      term: query,
      mode: "hybrid",
      properties: ["title", "url", "content"],
      boost: { title: 3, url: 2 },
      vector: { value: queryVector, property: "embedding" },
      similarity: 0.18,
      limit: 100,
    });
    if (run !== searchRun) return;
    const hybrid = documentsFromHits(hybridResults.hits);
    const displayHits = new Map(hybrid.bestHits);
    for (const [documentId, hit] of lexical.bestHits) {
      if (displayHits.has(documentId)) displayHits.set(documentId, hit);
    }
    const semanticOnly = new Set(hybrid.documents.filter((savedDocument) => !lexical.bestHits.has(savedDocument.id)).map((savedDocument) => savedDocument.id));
    render(hybrid.documents, query, displayHits, semanticOnly);
    $("#status").textContent = `${hybrid.documents.length} result${hybrid.documents.length === 1 ? "" : "s"} · Orama hybrid search · local ONNX embeddings`;
  } catch (error) {
    if (run !== searchRun) return;
    $("#status").textContent = `${lexical.documents.length} text result${lexical.documents.length === 1 ? "" : "s"} · semantic search unavailable`;
    console.warn("Semantic search unavailable:", error);
  }
}

$("#search").addEventListener("input", () => {
  clearTimeout(timer);
  timer = setTimeout(() => { void runSearch(); }, 300);
});

$("#clearLibrary").addEventListener("click", async () => {
  if (!confirm("Remove every saved article and PDF from this device?")) return;
  await clearDocuments();
  library = [];
  searchIndex = await createIndex();
  $("#clearLibrary").hidden = true;
  void runSearch();
});

try {
  library = await listDocuments({ limit: 100 });
  searchIndex = await createIndex();
  $("#clearLibrary").hidden = library.length === 0;
  void runSearch();
} catch (error) {
  $("#status").textContent = `Could not open the local library: ${error.message}`;
  $("#empty").hidden = false;
}
