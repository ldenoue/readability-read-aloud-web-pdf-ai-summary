import { create, insert, search as oramaSearch } from "@orama/orama";
import { documentText, embeddingTexts, listDocuments, removeDocument, clearDocuments, updateDocumentEmbeddings } from "./library-store.js";
import { embedTexts } from "./embedding-client.js";

const $ = (selector) => document.querySelector(selector);
let library = [];
let searchIndex;
let searchRun = 0;
let timer;

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

function render(savedDocuments, query = "") {
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
    meta.querySelector(".kind").textContent = savedDocument.kind === "pdf" ? "PDF" : "Article";
    meta.querySelector(".host").textContent = hostname;
    meta.querySelector(".date").textContent = new Date(savedDocument.lastViewedAt || savedDocument.updatedAt).toLocaleDateString();
    const excerpt = document.createElement("p");
    excerpt.className = "excerpt";
    excerpt.textContent = (savedDocument.summary?.text || documentText(savedDocument)).slice(0, 280);
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
    card.append(heading, meta, excerpt, remove);
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
  const scores = new Map();
  for (const hit of hits) scores.set(hit.document.documentId, Math.max(scores.get(hit.document.documentId) || 0, hit.score));
  return library.filter((savedDocument) => scores.has(savedDocument.id))
    .sort((left, right) => scores.get(right.id) - scores.get(left.id));
}

async function runSearch() {
  const run = ++searchRun;
  const query = $("#search").value.trim();
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
  const lexicalDocuments = documentsFromHits(textResults.hits);
  render(lexicalDocuments, query);
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
    const ranked = documentsFromHits(hybridResults.hits);
    render(ranked, query);
    $("#status").textContent = `${ranked.length} result${ranked.length === 1 ? "" : "s"} · Orama hybrid search · local ONNX embeddings`;
  } catch (error) {
    if (run !== searchRun) return;
    $("#status").textContent = `${lexicalDocuments.length} text result${lexicalDocuments.length === 1 ? "" : "s"} · semantic search unavailable`;
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
