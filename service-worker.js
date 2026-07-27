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
