<p align="center">
  <img src="icons/icon.svg" width="96" height="96" alt="Readability Reader icon">
</p>

<h1 align="center">Readability Reader</h1>

<p align="center">
  A private, local-first reader for articles and PDFs with AI summaries and natural text-to-speech.
</p>

![Readability Reader showing an extracted article, local AI summary, and text-to-speech controls](docs/readability-reader.png)

## What it does

Readability Reader is a Manifest V3 browser extension for Chrome and Firefox. Click its toolbar button on an article or PDF to open the content in a quiet, responsive reading view.

- Extracts article content locally with Mozilla Readability.
- Converts PDFs locally with PDF.js and preserves their text hierarchy and reading order.
- Detects PDF text, headings, pictures, tables, and formulas with a bundled DocLayNet layout model.
- Converts detected formulas to LaTeX locally and renders them with KaTeX.
- Produces concise on-device summaries with the browser's built-in Summarizer API when available.
- Reads content aloud with PocketTTS or Inflect Micro/Nano, with selectable voices and sentence-level highlighting.
- Normalizes punctuation and URLs for more natural speech, skips navigation and code, and announces article images from their accessible descriptions.
- Downloads voice and optional recognition models only when needed, then keeps them in persistent browser storage for reuse.

Article extraction, PDF conversion, layout analysis, speech synthesis, and supported summarization all happen locally. The extension does not send article or PDF text to an application server. Model files are downloaded directly from Hugging Face when first required.

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

PDF.js provides positioned text extraction and page rendering. A bundled DocLayNet YOLO model detects semantic page regions, visual crops preserve pictures and tables, and recursive XY-cut restores blocks to reading order. Formula regions are recognized with Texo/FormulaNet and rendered with KaTeX; table regions can be reconstructed with a locally downloaded recognition model.

Image-only scanned PDFs have no extractable text and currently require a separate OCR engine.

## Local storage

Downloaded voices and model weights are cached persistently so they do not need to be fetched for every reading session. **Clear all cached models/voices** removes those assets and resets the in-memory speech engines. Provider, voice, model, and playback preferences are stored separately in browser-local extension storage.

## Third-party components

- [Mozilla Readability](https://github.com/mozilla/readability) for article extraction.
- [PDF.js](https://github.com/mozilla/pdf.js) for PDF parsing and rendering (Apache-2.0).
- [KaTeX](https://katex.org/) for formula rendering.
- [Transformers.js](https://github.com/huggingface/transformers.js) and ONNX Runtime Web for local document models.
- [Texo / FormulaNet](https://github.com/alephpi/Texo) for formula recognition (AGPL-3.0).
- [PocketTTS](https://github.com/kyutai-labs/pocket-tts), [Inflect Micro](https://huggingface.co/owensong/Inflect-Micro-v2-ONNX), and [Inflect Nano](https://huggingface.co/owensong/Inflect-Nano-v2-ONNX) for local speech synthesis.
