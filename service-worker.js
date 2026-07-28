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
        const articleResult = ({ title, byline = "", siteName, publishedTime = "", content, kind = "article" }) => {
          const container = document.createElement("div");
          container.innerHTML = content;
          const textContent = container.textContent.replace(/\s+/g, " ").trim();
          return {
            title, byline, siteName, publishedTime, content, textContent,
            excerpt: textContent.slice(0, 280), length: textContent.length,
            language: document.documentElement.lang || "", sourceUrl: location.href, kind,
          };
        };

        const isChatGpt = /^(?:chatgpt\.com|chat\.openai\.com)$/i.test(location.hostname);
        const conversationTurns = isChatGpt ? [...document.querySelectorAll('[data-testid^="conversation-turn-"]')] : [];
        if (conversationTurns.length) {
          const conversation = document.createElement("article");
          conversation.className = "chatgpt-conversation";
          for (const turn of conversationTurns) {
            const messageElements = [...turn.querySelectorAll("[data-message-author-role]")]
              .filter((element) => element.closest('[data-testid^="conversation-turn-"]') === turn);
            const role = messageElements[0]?.getAttribute("data-message-author-role") || "unknown";
            const localizedAuthor = turn.querySelector("h4.sr-only, h5.sr-only, h6.sr-only")?.textContent
              ?.replace(/:\s*$/, "").trim();
            const author = localizedAuthor || ({ user: "You", assistant: "ChatGPT", tool: "Tool" }[role] || "Message");
            const section = document.createElement("section");
            section.className = `chat-message chat-message-${role}`;
            section.dataset.role = role;
            const heading = document.createElement("h2");
            heading.textContent = author;
            section.append(heading);

            const candidates = messageElements.flatMap((message) => [
              ...(message.matches(".markdown, .whitespace-pre-wrap") ? [message] : []),
              ...message.querySelectorAll(".markdown, .whitespace-pre-wrap"),
            ]);
            const contentElements = [...new Set(candidates)].filter((candidate, index, all) =>
              !all.some((other, otherIndex) => otherIndex !== index && other.contains(candidate)));
            for (const source of contentElements.length ? contentElements : messageElements) {
              const clone = source.cloneNode(true);
              clone.querySelectorAll("pre").forEach((pre) => {
                const codeMirror = pre.querySelector(".cm-content");
                if (!codeMirror) return;
                pre.querySelectorAll("button, [role='button']").forEach((element) => element.remove());
                const language = [...pre.querySelectorAll("div")]
                  .filter((element) => !element.contains(codeMirror))
                  .map((element) => element.textContent.trim())
                  .find((text) => /^[A-Za-z][\w+#.-]{0,19}$/u.test(text)) || "";
                const codeContent = codeMirror.cloneNode(true);
                codeContent.querySelectorAll("br").forEach((lineBreak) => lineBreak.replaceWith("\n"));
                const normalizedPre = document.createElement("pre");
                const code = document.createElement("code");
                if (language) { code.dataset.lang = language.toLowerCase(); code.className = `language-${language.toLowerCase()}`; }
                code.textContent = codeContent.textContent.replace(/\n{3,}/g, "\n\n").trim();
                normalizedPre.append(code);
                pre.replaceWith(normalizedPre);
              });
              clone.querySelectorAll("button, [role='button'], script, style, h4.sr-only, h5.sr-only, h6.sr-only").forEach((element) => element.remove());
              clone.querySelectorAll("span[data-state='closed']").forEach((element) => element.remove());
              const hasReadableBlocks = clone.matches("p, blockquote, li, pre, img, h1, h2, h3, h4, h5, h6")
                || clone.querySelector("p, blockquote, li, pre, img, h1, h2, h3, h4, h5, h6");
              if (hasReadableBlocks) section.append(...clone.childNodes);
              else if (clone.textContent.trim()) {
                const paragraph = document.createElement("p");
                paragraph.append(...clone.childNodes);
                section.append(paragraph);
              }
            }
            if (section.textContent.replace(author, "").trim() || section.querySelector("img, pre, code")) conversation.append(section);
          }
          const firstUserText = conversation.querySelector(".chat-message-user")?.textContent.replace(/\s+/g, " ").trim() || "";
          const pageTitle = document.title.replace(/\s*[-–|]\s*ChatGPT\s*$/i, "").trim();
          return articleResult({
            title: pageTitle && pageTitle !== "ChatGPT" ? pageTitle : firstUserText.slice(0, 80) || "ChatGPT conversation",
            siteName: "ChatGPT",
            content: conversation.outerHTML,
            kind: "chatgpt",
          });
        }

        const isXArticle = /^(?:www\.)?x\.com$/i.test(location.hostname);
        const richText = isXArticle
          ? document.querySelector('[data-testid="twitterArticleRichTextView"]')
          : null;
        if (richText) {
          const content = richText.cloneNode(true);
          content.querySelectorAll('[data-testid="markdown-code-block"]').forEach((block) => {
            const sourceCode = block.querySelector("code");
            if (!sourceCode) return;
            const pre = document.createElement("pre");
            const code = document.createElement("code");
            const language = sourceCode.className.match(/language-([\w-]+)/)?.[1]
              || block.querySelector("span")?.textContent.trim() || "";
            if (language) { code.className = `language-${language}`; code.dataset.lang = language; }
            code.textContent = sourceCode.textContent || "";
            pre.append(code);
            block.replaceWith(pre);
          });
          content.querySelectorAll('[data-testid="simpleTweet"]').forEach((tweet) => {
            const quote = document.createElement("blockquote");
            const author = tweet.querySelector('[data-testid="User-Name"]')?.textContent.replace(/\s+/g, " ").trim();
            const text = tweet.querySelector('[data-testid="tweetText"]')?.textContent.trim();
            if (author) { const cite = document.createElement("cite"); cite.textContent = author; quote.append(cite); }
            if (text) { const paragraph = document.createElement("p"); paragraph.textContent = text; quote.append(paragraph); }
            tweet.replaceWith(quote);
          });
          content.querySelectorAll('img[src*="/emoji/"]').forEach((image) => {
            if (image.getAttribute("alt")) image.replaceWith(image.getAttribute("alt"));
          });
          content.querySelectorAll('[data-testid="tweetPhoto"] img, img[src*="pbs.twimg.com/media"]').forEach((image) => {
            const source = image.getAttribute("src") || "";
            image.setAttribute("src", source.match(/[?&]name=/) ? source.replace(/([?&])name=[^&]+/, "$1name=large") : `${source}${source.includes("?") ? "&" : "?"}name=large`);
            image.setAttribute("alt", (image.getAttribute("alt") || "").replace(/\s+/g, " ").trim());
            const anchor = image.closest("a");
            if (anchor && content.contains(anchor)) anchor.replaceWith(image);
          });
          content.querySelectorAll('span[style*="font-weight: bold"]').forEach((span) => {
            const strong = document.createElement("strong");
            strong.append(...span.childNodes);
            span.replaceWith(strong);
          });
          content.querySelectorAll(".longform-unstyled, .public-DraftStyleDefault-block").forEach((block) => {
            const paragraph = document.createElement("p");
            paragraph.append(...block.childNodes);
            block.replaceWith(paragraph);
          });
          content.querySelectorAll("button, [role='button'], script, style").forEach((element) => element.remove());
          const readView = document.querySelector('[data-testid="twitterArticleReadView"]');
          const headerImage = readView?.querySelector('[data-testid="tweetPhoto"] img');
          if (headerImage && !richText.contains(headerImage)) {
            const image = document.createElement("img");
            const source = headerImage.getAttribute("src") || "";
            image.src = source.match(/[?&]name=/) ? source.replace(/([?&])name=[^&]+/, "$1name=large") : `${source}${source.includes("?") ? "&" : "?"}name=large`;
            image.alt = headerImage.getAttribute("alt")?.replace(/\s+/g, " ").trim() || "";
            content.prepend(image);
          }
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
          return articleResult({ title, byline, siteName: "X", publishedTime: document.querySelector("time[datetime]")?.getAttribute("datetime") || "", content: content.innerHTML, kind: "x-article" });
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
