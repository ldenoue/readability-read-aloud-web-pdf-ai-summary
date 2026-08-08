import localforage from "localforage";

const documents = localforage.createInstance({
  name: "readability-reader",
  storeName: "documents",
  description: "Locally saved articles and processed PDFs",
});

export async function documentIdForUrl(sourceUrl) {
  const bytes = new TextEncoder().encode(sourceUrl);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("").slice(0, 24);
}

export async function saveDocument(input) {
  const now = Date.now();
  const id = input.id || await documentIdForUrl(input.sourceUrl);
  const previous = await documents.getItem(id);
  const document = {
    ...previous,
    ...input,
    id,
    createdAt: previous?.createdAt || input.createdAt || now,
    updatedAt: now,
    lastViewedAt: now,
  };
  await documents.setItem(id, document);
  return document;
}

export async function getDocument(id) {
  return id ? documents.getItem(id) : null;
}

export async function getDocumentByUrl(sourceUrl) {
  return sourceUrl ? getDocument(await documentIdForUrl(sourceUrl)) : null;
}

export async function touchDocument(id) {
  const document = await getDocument(id);
  if (!document) return null;
  document.lastViewedAt = Date.now();
  await documents.setItem(id, document);
  return document;
}

export async function listDocuments({ limit = 100 } = {}) {
  const values = [];
  await documents.iterate((document) => { if (document?.id) values.push(document); });
  return values.sort((left, right) => (right.lastViewedAt || right.updatedAt || 0) - (left.lastViewedAt || left.updatedAt || 0)).slice(0, limit);
}

export async function updateDocumentEmbeddings(id, embeddingChunks) {
  const document = await getDocument(id);
  if (!document) return null;
  document.embeddingChunks = embeddingChunks;
  document.embeddingModel = "Xenova/all-MiniLM-L6-v2";
  document.embeddingUpdatedAt = Date.now();
  await documents.setItem(id, document);
  return document;
}

export async function updateDocumentSummary(id, summary) {
  const document = await getDocument(id);
  if (!document) return null;
  document.summary = summary;
  document.updatedAt = Date.now();
  await documents.setItem(id, document);
  return document;
}

export async function updateDocumentPassageHighlights(id, passageHighlights) {
  const document = await getDocument(id);
  if (!document) return null;
  document.passageHighlights = passageHighlights;
  document.updatedAt = Date.now();
  await documents.setItem(id, document);
  return document;
}

export async function removeDocument(id) {
  await documents.removeItem(id);
}

export async function clearDocuments() {
  await documents.clear();
}

export function documentText(document) {
  return (document.passages || []).flatMap((passage) => {
    if (passage.text) return [passage.text];
    if (passage.type === "table") return passage.table?.rows?.map((row) => row.cells.map((cell) => cell.text).join(" ")) || [];
    return [];
  }).filter(Boolean).join("\n");
}

export function embeddingTexts(document, maxCharacters = 1200, maxChunks = 32) {
  const title = document.metadata?.title || document.title || "";
  const content = (document.passages || []).flatMap((passage) => {
    if (passage.text) return [passage.text];
    if (passage.type === "table") return passage.table?.rows?.map((row) => row.cells.map((cell) => cell.text).join(" ")) || [];
    return [];
  }).filter(Boolean).join("\n");
  const chunks = [];
  let offset = 0;
  const prefix = title ? `${title}\n` : "";
  const contentLimit = Math.max(200, maxCharacters - prefix.length);
  while (offset < content.length && chunks.length < maxChunks) {
    let end = Math.min(content.length, offset + contentLimit);
    if (end < content.length) {
      const wordEnd = content.lastIndexOf(" ", end);
      if (wordEnd > offset + contentLimit * 0.6) end = wordEnd;
    }
    const text = content.slice(offset, end).trim();
    if (text) chunks.push(`${prefix}${text}`.slice(0, maxCharacters));
    offset = end;
    while (/\s/u.test(content[offset] || "")) offset++;
  }
  if (!chunks.length && title) chunks.push(title.slice(0, maxCharacters));
  return chunks;
}
