const PLAYER_ENDPOINT = "https://release-youtubei.sandbox.googleapis.com/youtubei/v1/player";

export function youtubeVideoId(sourceUrl) {
  try {
    const url = new URL(sourceUrl);
    if (/^(?:www\.|m\.)?youtube\.com$/i.test(url.hostname)) {
      if (url.pathname === "/watch") return url.searchParams.get("v") || "";
      const match = url.pathname.match(/^\/(?:shorts|live|embed)\/([\w-]{11})/i);
      return match?.[1] || "";
    }
    if (/^youtu\.be$/i.test(url.hostname)) return url.pathname.split("/").filter(Boolean)[0] || "";
  } catch {}
  return "";
}

export async function getLocalYouTubeTranscript(videoId) {
  const response = await fetch(PLAYER_ENDPOINT, {
    method: "POST",
    cache: "no-cache",
    credentials: "omit",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    referrerPolicy: "no-referrer",
    body: JSON.stringify({
      videoId,
      context: { client: { hl: "en", clientName: "ANDROID", clientVersion: "20.10.38" } },
    }),
  });
  if (!response.ok) throw new Error(`YouTube returned ${response.status} while loading this video.`);
  const json = await response.json();
  if (json.playabilityStatus?.status === "ERROR") throw new Error("This YouTube video is not playable.");
  if (!json.videoDetails) throw new Error("YouTube did not return video details.");

  const tracks = json.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  const preferredTrack = tracks.find((track) => /^en(?:-|$)/i.test(track.languageCode)) || tracks[0];
  if (!preferredTrack?.baseUrl) throw new Error("No transcript is available for this YouTube video.");
  const transcriptResponse = await fetch(preferredTrack.baseUrl, { credentials: "omit", referrerPolicy: "no-referrer" });
  if (!transcriptResponse.ok) throw new Error(`YouTube returned ${transcriptResponse.status} while loading the transcript.`);
  const chunks = timedTextChunks(await transcriptResponse.text());
  if (!chunks.length) throw new Error("The YouTube transcript is empty.");

  const details = json.videoDetails;
  const duration = Number(details.lengthSeconds) || 0;
  const chapters = normalizeChapters(details.chapters) || chaptersFromDescription(details.shortDescription || "", duration);
  const published = json.microformat?.playerMicroformatRenderer?.publishDate || "";
  return {
    videoId: details.videoId || videoId,
    title: details.title || "YouTube video",
    author: details.author || "",
    description: details.shortDescription || "",
    duration,
    language: preferredTrack.languageCode || "",
    published,
    chapters,
    chunks,
  };
}

export function youtubeTranscriptArticle(transcript, sourceUrl) {
  const passages = transcriptPassages(transcript.chunks, transcript.chapters, transcript.language);
  const content = passages.map((passage) => passage.type === "heading"
    ? `<h2>${escapeHtml(passage.text)}</h2>`
    : `<p>${escapeHtml(passage.text)}</p>`).join("\n");
  return {
    title: transcript.title,
    byline: transcript.author,
    siteName: "YouTube",
    publishedTime: transcript.published,
    excerpt: passages.find((passage) => passage.type === "paragraph")?.text.slice(0, 240) || "",
    content,
    textContent: passages.map((passage) => passage.text).join("\n"),
    length: passages.reduce((sum, passage) => sum + passage.text.length, 0),
    language: transcript.language,
    sourceUrl,
    kind: "youtube",
    videoId: transcript.videoId,
    duration: transcript.duration,
    chapters: transcript.chapters,
  };
}

function timedTextChunks(xml) {
  const chunks = [];
  const pattern = /<(text|p)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
  for (const match of xml.matchAll(pattern)) {
    const attributes = match[2];
    const modern = match[1].toLowerCase() === "p";
    const start = Number(attribute(attributes, modern ? "t" : "start")) * (modern ? 1 : 1000);
    const duration = Number(attribute(attributes, modern ? "d" : "dur")) * (modern ? 1 : 1000);
    const text = decodeEntities(match[3].replace(/<[^>]+>/g, " "))
      .replace(/\[[^\]]*\]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (text) chunks.push({ text, start: Number.isFinite(start) ? start : 0, duration: Number.isFinite(duration) ? duration : 0 });
  }
  return chunks;
}

function transcriptPassages(chunks, chapters, language = "en") {
  const passages = [];
  let transcriptText = "";
  const chunkOffsets = [];
  for (const chunk of chunks) {
    if (transcriptText) transcriptText += " ";
    chunkOffsets.push({ time: chunk.start, offset: transcriptText.length });
    transcriptText += chunk.text;
  }
  const sentenceEnds = transcriptSentenceEnds(transcriptText, language);
  const positionedChapters = chapters.map((chapter) => {
    const target = chunkOffsets.find((chunk) => chunk.time >= chapter.start)?.offset ?? transcriptText.length;
    const offset = target === 0 ? 0 : sentenceEnds.find((end) => end >= target) ?? transcriptText.length;
    return { ...chapter, offset };
  }).filter((chapter, index, list) => chapter.text && chapter.offset < transcriptText.length
    && !list.slice(0, index).some((previous) => previous.offset === chapter.offset));
  let cursor = 0;
  for (const chapter of positionedChapters) {
    if (chapter.offset > cursor) passages.push(...transcriptParagraphs(transcriptText.slice(cursor, chapter.offset), language).map((text) => ({ type: "paragraph", text })));
    passages.push({ type: "heading", text: chapter.text });
    cursor = chapter.offset;
  }
  passages.push(...transcriptParagraphs(transcriptText.slice(cursor), language).map((text) => ({ type: "paragraph", text })));
  return passages;
}

function transcriptParagraphs(text, language) {
  const speakerBoundary = "\uE000";
  const normalized = text
    .replace(/\s*>>\s*(?=["“‘'(\[]*\p{Lu})/gu, speakerBoundary)
    .replace(/\s*>>\s*/gu, " ");
  const turns = normalized.split(speakerBoundary);
  const paragraphs = [];
  turns.forEach((turn, turnIndex) => {
    const clean = turn.replace(/\s+/g, " ").trim();
    if (!clean) return;
    const sentences = segmentTranscriptSentences(clean, language);
    let paragraph = turnIndex > 0 ? "— " : "";
    for (const sentence of sentences) {
      if (paragraph.replace(/^—\s*/u, "") && paragraph.length + sentence.length + 1 > 700) {
        paragraphs.push(paragraph.trim());
        paragraph = "";
      }
      paragraph += `${paragraph && !paragraph.endsWith(" ") ? " " : ""}${sentence}`;
    }
    if (paragraph.trim() && paragraph.trim() !== "—") paragraphs.push(paragraph.trim());
  });
  return paragraphs;
}

function segmentTranscriptSentences(text, language) {
  if (typeof Intl.Segmenter === "function") {
    try {
      const segmenter = new Intl.Segmenter(language || undefined, { granularity: "sentence" });
      const sentences = [...segmenter.segment(text)].map(({ segment }) => segment.trim()).filter(Boolean);
      if (sentences.length) return sentences;
    } catch {}
  }
  return text.match(/[^.!?]+(?:[.!?]+|$)/gu)?.map((sentence) => sentence.trim()).filter(Boolean) || [text];
}

function transcriptSentenceEnds(text, language) {
  if (typeof Intl.Segmenter === "function") {
    try {
      const segmenter = new Intl.Segmenter(language || undefined, { granularity: "sentence" });
      return [...segmenter.segment(text)].map(({ index, segment }) => index + segment.length);
    } catch {}
  }
  return [...text.matchAll(/[^.!?]+(?:[.!?]+|$)/gu)].map((match) => (match.index || 0) + match[0].length);
}

function normalizeChapters(chapters) {
  if (!Array.isArray(chapters) || !chapters.length) return null;
  const normalized = chapters.map((chapter) => ({
    text: String(chapter.text || chapter.title || "").trim(),
    start: Number.isFinite(chapter.start) ? chapter.start : Number(chapter.start_time) * 1000,
  })).filter((chapter) => chapter.text && Number.isFinite(chapter.start));
  return normalized.length ? normalized.sort((left, right) => left.start - right.start) : null;
}

function chaptersFromDescription(description, durationSeconds) {
  const chapters = [];
  for (const line of description.split("\n")) {
    const match = line.match(/^\s*(?:[•*-]\s*)?((?:\d{1,2}:)?\d{1,2}:\d{2})\s*(?:[-–—:]\s*)?(.+)$/);
    if (!match) continue;
    const parts = match[1].split(":").map(Number);
    const seconds = parts.reduce((total, value) => total * 60 + value, 0);
    if (!Number.isFinite(seconds) || seconds > durationSeconds + 5) continue;
    chapters.push({ text: match[2].trim(), start: seconds * 1000 });
  }
  return chapters.length >= 2 ? chapters.sort((left, right) => left.start - right.start) : [];
}

function attribute(source, name) {
  return source.match(new RegExp(`\\b${name}=["']([^"']+)["']`, "i"))?.[1] || "0";
}

function decodeEntities(text) {
  return text.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (entity, value) => {
    if (value[0] === "#") return String.fromCodePoint(Number.parseInt(value.slice(value[1]?.toLowerCase() === "x" ? 2 : 1), value[1]?.toLowerCase() === "x" ? 16 : 10));
    return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" })[value.toLowerCase()] || entity;
  });
}

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}
