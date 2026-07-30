import { getLocalYouTubeTranscript, youtubeTranscriptArticle, youtubeVideoId } from "./youtube-transcript.js";

const YOUTUBE_IDENTITY_RULE = 153001;
const YOUTUBE_APP_IDENTITY = "https://readability-read-aloud.gpgkihaonhnhfabcmgnmkjlmoegfkbne/";

async function configureYouTubeEmbedIdentity() {
  if (!chrome.declarativeNetRequest?.updateDynamicRules) return;
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [YOUTUBE_IDENTITY_RULE],
      addRules: [{
        id: YOUTUBE_IDENTITY_RULE,
        priority: 1,
        action: {
          type: "modifyHeaders",
          requestHeaders: [{ header: "Referer", operation: "set", value: YOUTUBE_APP_IDENTITY }],
        },
        condition: {
          requestDomains: ["youtube.com", "youtube-nocookie.com"],
          initiatorDomains: [chrome.runtime.id],
          resourceTypes: ["sub_frame"],
        },
      }],
    });
  } catch (error) {
    console.warn("Could not configure YouTube embed identity:", error);
  }
}

void configureYouTubeEmbedIdentity();

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
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["dist/readability.js", "dist/defuddle.js"] });
    const [{ result: article }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: async () => {
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

        const isGmail = /^(?:mail\.)?google\.com$/i.test(location.hostname) && location.pathname.startsWith("/mail/");
        const gmailRows = isGmail ? [...document.querySelectorAll(".adn.ads")] : [];
        if (gmailRows.length) {
          const thread = document.createElement("article");
          thread.className = "gmail-thread";
          const removeFromMessage = [
            ".gmail_quote", ".gmail_attr", ".gmail_extra", "blockquote[type='cite']", ".moz-cite-prefix",
            "blockquote[style*='border-left']", ".yahoo_quoted", ".a6S", ".adL", ".h5", ".adm",
            ".ajR", ".ajT", ".h4", ".yj6qo",
          ].join(",");
          for (const row of gmailRows) {
            const body = row.querySelector(".a3s");
            if (!body) continue;
            const content = body.cloneNode(true);
            content.classList.add("comment-content");
            content.querySelectorAll(removeFromMessage).forEach((element) => element.remove());
            if (!content.textContent.trim() && !content.querySelector("img, video, audio, table, pre")) continue;
            const section = document.createElement("section");
            section.className = "gmail-message";
            const sender = row.querySelector(".gD");
            const author = sender?.getAttribute("name")?.trim() || sender?.textContent.trim() || "Unknown sender";
            const date = row.querySelector(".g3")?.getAttribute("title")?.trim() || row.querySelector(".g3")?.textContent.trim() || "";
            const heading = document.createElement("h2");
            heading.textContent = date ? `${author} - ${date}` : author;
            section.append(heading, ...content.childNodes);
            thread.append(section);
          }
          if (thread.childElementCount) {
            const subject = document.querySelector("h2.hP, .hP")?.textContent.replace(/\s+/g, " ").trim() || document.title.replace(/\s+-\s+Gmail\s*$/i, "").trim() || "Gmail thread";
            const firstSender = gmailRows[0]?.querySelector(".gD");
            return articleResult({
              title: subject,
              byline: firstSender?.getAttribute("name")?.trim() || firstSender?.textContent.trim() || "",
              siteName: "Gmail",
              content: thread.outerHTML,
              kind: "gmail",
            });
          }
        }

        const isXArticle = /^(?:www\.)?x\.com$/i.test(location.hostname);
        const richText = isXArticle
          ? document.querySelector('[data-testid="twitterArticleRichTextView"]')
          : null;
        if (richText) {
          try {
            const defuddle = new globalThis.__LocalDefuddle(document.cloneNode(true), {
              url: location.href,
              includeReplies: "extractors",
              removeImages: false,
              useAsync: true,
            });
            const extracted = await defuddle.parseAsync();
            if (extracted?.content?.trim()) {
              return articleResult({
                title: extracted.title || document.title || "X article",
                byline: extracted.author || "",
                siteName: extracted.site || "X",
                publishedTime: extracted.published || document.querySelector("time[datetime]")?.getAttribute("datetime") || "",
                content: extracted.content,
                kind: `defuddle-${extracted.extractorType || "x-article"}`,
              });
            }
          } catch (error) {
            console.warn("Defuddle X article extraction failed; using the DOM fallback:", error);
          }
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
          const xRichBlockSelector = ".longform-unstyled, .public-DraftStyleDefault-block";
          [...content.querySelectorAll(xRichBlockSelector)].filter((block) => {
            if (!block.matches("div, section")) return false;
            return ![...block.querySelectorAll(xRichBlockSelector)].some((nested) => nested.matches("div, section"));
          }).forEach((block) => {
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

        try {
          const defuddle = new globalThis.__LocalDefuddle(document.cloneNode(true), {
            url: location.href,
            includeReplies: "extractors",
            removeImages: false,
            useAsync: true,
          });
          const extracted = await defuddle.parseAsync();
          if (extracted?.extractorType && extracted.content?.trim()) {
            const geminiBrowserTitle = /^(?:gemini\.google\.com)$/i.test(location.hostname)
              ? document.title.replace(/\s+-\s+Google Gemini\s*$/i, "").trim()
              : "";
            return articleResult({
              title: geminiBrowserTitle && !/^(?:New Chat|Gemini)$/i.test(geminiBrowserTitle) ? geminiBrowserTitle : extracted.title || document.title,
              byline: extracted.author || "",
              siteName: extracted.site || extracted.domain || location.hostname,
              publishedTime: extracted.published || "",
              content: extracted.content,
              kind: `defuddle-${extracted.extractorType}`,
            });
          }
        } catch (error) {
          console.warn("Defuddle extractor failed; falling back to Readability:", error);
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
