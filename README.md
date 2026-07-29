<p align="center">
  <img src="icons/icon.svg" width="96" height="96" alt="Readability Reader icon">
</p>

<h1 align="center">Readability Reader</h1>

<p align="center">
  A private, local-first reader for articles, PDFs, X articles, and YouTube transcripts with AI summaries and natural text-to-speech.
</p>

<p align="center">
  <strong><a href="https://chromewebstore.google.com/detail/gpgkihaonhnhfabcmgnmkjlmoegfkbne">Install Readability Reader from the Chrome Web Store</a></strong>
</p>

![Readability Reader showing an extracted article, local AI summary, and text-to-speech controls](docs/readability-reader.png)

## What it does

Readability Reader is a Manifest V3 browser extension for Chrome and Firefox. Click its toolbar button on an article, PDF, AI conversation, email thread, social discussion, GitHub issue, forum topic, X long-form article, or YouTube video to open the content in a quiet, responsive reading view.

- Extracts article content locally with Mozilla Readability.
- Uses Defuddle's complete site-specific extractor registry for Claude, Gemini, Grok, Gmail, GitHub issues and pull requests, Reddit, Hacker News, Discourse, Bluesky, Threads, Mastodon, LinkedIn, Medium, Substack, Wikipedia, and other supported sites.
- Extracts X long-form articles from their dedicated rich-text container, including headings, lists, quotations, and images.
- Turns available YouTube captions and chapters into sentence-aware readable transcripts with speaker turns.
- Converts PDFs locally with PDF.js and preserves their text hierarchy and reading order.
- Detects PDF text, headings, pictures, tables, and formulas with a bundled DocLayNet layout model.
- Converts detected formulas to LaTeX locally and renders them with KaTeX.
- Lets users optionally generate an on-device summary with either Chrome's built-in Summarizer API or Gemma 3 270M Instruct running through WebGPU.
- Reads content aloud with PocketTTS or Inflect Micro/Nano, with selectable voices and sentence-level highlighting.
- Saves processed articles, PDFs, YouTube transcripts, X articles, and generated local AI summaries so reader tabs survive refreshes without repeating work.
- Provides a private recent-reading library with Orama full-text and hybrid semantic search across titles, URLs, and content.
- Exports the cleaned reading view as a paginated PDF for sharing or attaching to email, including its source, byline, and available local AI summary.
- Normalizes punctuation and URLs for more natural speech, skips navigation and code, and announces article images from their accessible descriptions.
- Downloads voice and optional recognition models only when needed, then keeps them in persistent browser storage for reuse.

Article extraction, PDF conversion, layout analysis, transcript formatting, speech synthesis, and supported summarization all happen locally. The extension does not send extracted content to an application server. YouTube metadata and captions are fetched directly from YouTube; model files are downloaded directly from Hugging Face when first required.

## Optional local AI summaries

Summaries are never generated automatically. Choose **Local Chrome API · speed** or **Gemma 3 270M Instruct · WebGPU** in the summary panel, then select the generate button when you want one. Chrome summaries explicitly request its low-latency model preference and do not silently fall back to the larger automatic model. Gemma uses its tokenizer to build focused, grounded source windows; oversized documents use faithful section notes followed by a dedicated final synthesis. The chosen provider is remembered locally, and generated summaries are saved with their documents for refreshes, search results, and PDF exports.

The Chrome option uses the browser's built-in Summarizer API and its supported languages. The WebGPU option runs the q4f16 [Gemma 3 270M Instruct ONNX model](https://huggingface.co/onnx-community/gemma-3-270m-it-ONNX) locally in a dedicated worker with Transformers.js 4. Long documents are summarized in grounded sections and recursively reduced into a final summary. Model files are downloaded only after the user requests a Gemma summary and remain in the browser model cache for reuse.

## Export to PDF

Once an article is ready, select **Export article as PDF** in the reader controls. The extension uses [dompdf.js](https://github.com/lmn1919/dompdf.js) locally to turn the cleaned article, images, source details, and saved local AI summary into a paginated A4 PDF. Article images are downloaded when the document is first saved and stored alongside its passages, so PDF export never depends on a remote image host. The resulting file downloads directly from the browser; no document content is sent to a conversion service.

## Local library and search

Every successfully extracted article, processed PDF, and YouTube transcript receives a stable, URL-derived document ID and is saved in the browser with [localForage](https://github.com/localForage/localForage). Refreshing or reopening its reader URL restores the saved passages, PDF crops, reconstructed tables, formulas, metadata, and generated summary instead of downloading and processing the source again.

The library lists the 100 most recently viewed documents and searches their titles, source URLs, and complete extracted content. [Orama](https://github.com/oramasearch/orama) supplies BM25 full-text search, typo tolerance, vector indexing, and hybrid ranking. A quantized [all-MiniLM-L6-v2](https://huggingface.co/Xenova/all-MiniLM-L6-v2) model generates 384-dimensional embeddings locally through [Transformers.js](https://github.com/huggingface/transformers.js) and [ONNX Runtime Web](https://github.com/microsoft/onnxruntime). Embeddings are created in a dedicated worker, capped per document to control storage and indexing time, and stored alongside the document. Full-text indexing always covers the entire document.

The reader keeps a wide search box directly beside the **Readability Reader** logo, so the saved library is reachable without leaving the article controls. Entering a query opens the library with that search already active; the library keeps the same search box in its header and updates results as you type. Clicking the logo opens recent documents without a query, and clicking the extension toolbar icon from a page it cannot extract also opens the library.

Individual documents can be deleted directly from the reader or library, and the complete library can be cleared from the library page. Removing a document also removes its summary and embeddings; the local search index is rebuilt from the remaining records. No saved content, summaries, search terms, or embeddings leave the device.

## Build from source

Requirements: a current Node.js/npm installation and the `zip` command for release packaging.

```sh
npm install
npm run build
```

The build creates the bundled runtime files, fonts, PDF.js assets, and extension icons needed to load the source directory as an unpacked extension.

## Create browser packages

```sh
npm run package
```

Versioned Chrome and Firefox archives are written to `release/`. To create just one archive, run:

```sh
npm run package:chrome
npm run package:firefox
```

The Firefox package receives a Firefox-specific Manifest V3 background declaration and Gecko extension metadata. Both archives contain only runtime files—source-only files, npm metadata, and dependencies are excluded.

## Load an unpacked build

### Chrome

1. Run `npm install && npm run build`.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Select **Load unpacked** and choose this repository directory.
5. Pin Readability Reader, open an article or PDF, and click its toolbar icon.

To open local `file:///…` PDFs, enable **Allow access to file URLs** in the extension's details.

### Firefox

1. Run `npm install && npm run package:firefox`.
2. Open `about:debugging#/runtime/this-firefox`.
3. Select **Load Temporary Add-on**.
4. Choose the generated Firefox ZIP in `release/`.

## PDF processing

PDF.js provides positioned text extraction and page rendering. A bundled DocLayNet YOLO model detects semantic page regions, visual crops preserve pictures and tables, and recursive XY-cut restores blocks to reading order. The reader normalizes body typography while preserving detected bold and italic blocks, promotes a likely title to H1, removes repeated marginal headers and footers, and derives library titles from the largest horizontal text in the first three pages. Formula regions are recognized with Texo/FormulaNet and rendered with KaTeX; table regions can be reconstructed with a locally downloaded recognition model.

Saved PDFs include a reprocess button for rerunning extraction after the pipeline improves. Numbered references support hover and keyboard previews, and citation jumps add a history entry so the browser Back button returns to the previous reading position.

## ChatGPT, YouTube, and X

ChatGPT conversation pages use a dedicated extractor that collects every visible user and assistant turn instead of asking generic article heuristics to select one message. Split assistant response fragments are reunited, message roles remain visible, and images and code blocks are retained in the saved, searchable conversation.

For YouTube watch, short, live, embed, and share links, the extension requests available captions directly from YouTube and formats them into complete sentences with `Intl.Segmenter`. The reader embeds the privacy-enhanced YouTube player locally in the transcript view; clicking a timestamped sentence seeks and plays that embedded video without activating or controlling another browser tab, and playback time continuously advances the highlighted transcript sentence. YouTube requires embedded clients to identify themselves, so the extension supplies its Chrome Web Store app identity as the Referer only for YouTube player frames initiated by the extension. Chapter headings move to the end of the sentence containing their timestamp so they do not split speech. A `>>` marker starts an em-dash speaker paragraph only when followed by an uppercase word; false markers inside a sentence are removed.

X long-form articles use the platform's dedicated rich-text article container instead of generic page extraction. The extractor preserves semantic blocks, header and inline images, embedded posts, bold text, and code sections; reads the dedicated article title; resolves author names and handles; replaces emoji images with accessible text; and requests larger X media variants. The ChatGPT and X implementations incorporate robust extraction patterns from Defuddle.

Other supported sites run through Defuddle's maintained browser extractor registry before the generic Readability fallback. Conversation extractors preserve complete Claude, Gemini, and Grok sessions; Gmail removes duplicated quoted history from expanded email threads; GitHub, Reddit, Hacker News, and Discourse retain posts and visible replies; and social extractors preserve multi-post threads, media, quotations, cards, and discussion context. Structured tables and code produced by these extractors remain readable, searchable, locally saved, and available to PDF export.

Image-only scanned PDFs have no extractable text and currently require a separate OCR engine.

## Local storage

Articles, article images, processed PDFs, PDF visual crops, ChatGPT conversations, X articles, YouTube transcripts, summaries, and semantic embeddings are stored in IndexedDB through localForage. Downloaded voices and model weights use persistent browser caches so they do not need to be fetched for every reading session. **Clear all cached models/voices** removes model assets and resets the in-memory speech engines without deleting the reading library. Provider, voice, model, and playback preferences are stored separately in browser-local extension storage.

## Third-party components

- [Mozilla Readability](https://github.com/mozilla/readability) for article extraction.
- [Defuddle](https://github.com/kepano/defuddle) for its complete maintained registry of conversation, mail, developer, forum, social, video, and publishing extractors (MIT).
- [PDF.js](https://github.com/mozilla/pdf.js) for PDF parsing and rendering (Apache-2.0).
- [KaTeX](https://katex.org/) for formula rendering.
- [Transformers.js](https://github.com/huggingface/transformers.js) and [ONNX Runtime Web](https://github.com/microsoft/onnxruntime) for local document and embedding inference.
- [all-MiniLM-L6-v2](https://huggingface.co/Xenova/all-MiniLM-L6-v2) for local semantic-search embeddings.
- [Orama](https://github.com/oramasearch/orama) for local full-text, vector, and hybrid search.
- [localForage](https://github.com/localForage/localForage) for durable browser-side document storage.
- [dompdf.js](https://github.com/lmn1919/dompdf.js) for local, paginated PDF export.
- [Texo / FormulaNet](https://github.com/alephpi/Texo) for formula recognition (AGPL-3.0).
- [PocketTTS](https://github.com/kyutai-labs/pocket-tts), [Inflect Micro](https://huggingface.co/owensong/Inflect-Micro-v2-ONNX), and [Inflect Nano](https://huggingface.co/owensong/Inflect-Nano-v2-ONNX) for local speech synthesis.
