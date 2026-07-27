import { getLocalYouTubeTranscript, youtubeTranscriptArticle, youtubeVideoId } from "./youtube-transcript.js";

async function pointsToPdf(url) {
  if (/\.pdf(?:$|[?#])/i.test(url)) return true;
  try {
    const parsed = new URL(url);
    if (/^(?:www\.)?arxiv\.org$/i.test(parsed.hostname) && /^\/pdf\/[^/]+\/?$/i.test(parsed.pathname)) return true;
    const response = await fetch(url, { method: "HEAD", credentials: "include" });
    return /application\/pdf/i.test(response.headers.get("content-type") || "");
  } catch {
    return false;
  }
}

chrome.action.onClicked.addListener(async (tab) => {
  const sourceUrl = tab.url || "";
  if (!tab.id || !/^(https?|file):\/\//i.test(sourceUrl)) {
    await chrome.tabs.create({ url: chrome.runtime.getURL("library.html") });
    return;
  }

  const videoId = youtubeVideoId(sourceUrl);
  if (videoId) {
    try {
      const canonicalUrl = `https://www.youtube.com/watch?v=${videoId}`;
      const article = youtubeTranscriptArticle(await getLocalYouTubeTranscript(videoId), canonicalUrl);
      const id = crypto.randomUUID();
      await chrome.storage.session.set({ [id]: article });
      const readerUrl = new URL(chrome.runtime.getURL("reader.html"));
      readerUrl.searchParams.set("id", id);
      await chrome.tabs.create({ url: readerUrl.href });
    } catch (error) {
      const readerUrl = new URL(chrome.runtime.getURL("reader.html"));
      readerUrl.searchParams.set("error", error instanceof Error ? error.message : String(error));
      await chrome.tabs.create({ url: readerUrl.href });
    }
    return;
  }

  if (await pointsToPdf(sourceUrl)) {
    const readerUrl = new URL(chrome.runtime.getURL("reader.html"));
    readerUrl.searchParams.set("pdf", sourceUrl);
    await chrome.tabs.create({ url: readerUrl.href });
    return;
  }

  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["dist/readability.js"] });
    const [{ result: article }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const isXArticle = /^(?:www\.)?x\.com$/i.test(location.hostname);
        const richText = isXArticle
          ? document.querySelector('[data-testid="twitterArticleRichTextView"] [data-testid="longformRichTextComponent"], [data-testid="twitterArticleRichTextView"]')
          : null;
        if (richText) {
          const content = richText.cloneNode(true);
          content.querySelectorAll('img[src*="/emoji/"]').forEach((image) => {
            if (image.getAttribute("alt")) image.replaceWith(image.getAttribute("alt"));
          });
          content.querySelectorAll('img[src*="pbs.twimg.com/media"]').forEach((image) => {
            const source = image.getAttribute("src") || "";
            image.setAttribute("src", source.match(/[?&]name=/) ? source.replace(/([?&])name=[^&]+/, "$1name=large") : `${source}${source.includes("?") ? "&" : "?"}name=large`);
            image.setAttribute("alt", (image.getAttribute("alt") || "").replace(/\s+/g, " ").trim());
          });
          content.querySelectorAll("div.longform-unstyled[data-block='true']").forEach((block) => {
            const paragraph = document.createElement("p");
            paragraph.textContent = block.textContent;
            block.replaceWith(paragraph);
          });
          content.querySelectorAll("button, [role='button'], script, style").forEach((element) => element.remove());
          const textContent = content.textContent.replace(/\s+/g, " ").trim();
          const title = document.querySelector('[data-testid="twitter-article-title"], [data-testid="twitterArticleTitle"], h1')?.textContent.replace(/\s+/g, " ").trim()
            || document.title.replace(/\s*\/\s*X\s*$/i, "").trim()
            || "X article";
          const nameElement = document.querySelector('[data-testid="User-Name"]');
          const nameLinks = nameElement ? [...nameElement.querySelectorAll("a")] : [];
          const handle = nameLinks.map((link) => link.textContent.trim()).find((text) => /^@\w{1,15}$/.test(text))
            || nameElement?.textContent.match(/@\w{1,15}/)?.[0]
            || "";
          const displayName = nameLinks.map((link) => link.querySelector("time") ? "" : link.textContent.replace(/\s+/g, " ").trim())
            .find((text) => text && text !== handle && !text.startsWith("@"))
            || nameElement?.children[0]?.textContent.replace(/\s+/g, " ").trim()
            || "";
          const byline = [displayName, handle].filter(Boolean).join(" ");
          return {
            title,
            byline,
            siteName: "X",
            publishedTime: document.querySelector("time[datetime]")?.getAttribute("datetime") || "",
            excerpt: textContent.slice(0, 280),
            content: content.innerHTML,
            textContent,
            length: textContent.length,
            language: document.documentElement.lang || "",
            sourceUrl: location.href,
          };
        }
        const parsed = new globalThis.__LocalReadability(document.cloneNode(true)).parse();
        delete globalThis.__LocalReadability;
        if (!parsed) return null;
        return {
          title: parsed.title,
          byline: parsed.byline,
          siteName: parsed.siteName,
          publishedTime: parsed.publishedTime,
          excerpt: parsed.excerpt,
          content: parsed.content,
          textContent: parsed.textContent,
          length: parsed.length,
          language: document.documentElement.lang || "",
          sourceUrl: location.href,
        };
      },
    });
    if (!article?.content) throw new Error("Readability could not find an article on this page.");

    const id = crypto.randomUUID();
    await chrome.storage.session.set({ [id]: article });
    const readerUrl = new URL(chrome.runtime.getURL("reader.html"));
    readerUrl.searchParams.set("id", id);
    await chrome.tabs.create({ url: readerUrl.href });
  } catch (error) {
    const readerUrl = new URL(chrome.runtime.getURL("reader.html"));
    readerUrl.searchParams.set("error", error instanceof Error ? error.message : String(error));
    await chrome.tabs.create({ url: readerUrl.href });
  }
});
