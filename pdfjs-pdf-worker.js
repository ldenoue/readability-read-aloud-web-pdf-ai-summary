let pdfjs;
let DocLayoutDetector;
let visualDetections;
let xyCut;
let MathFormulaRecognizer;
let TableStructureRecognizer;
let reconstructTable;

self.postMessage({ type: "booting" });
try {
  pdfjs = await import("./pdfjs/pdf.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = new URL("./pdfjs/pdf.worker.mjs", import.meta.url).href;
  ({ DocLayoutDetector, visualDetections, xyCut } = await import("./dist/yolo-layout.js"));
  ({ MathFormulaRecognizer } = await import("./dist/math-ocr.js"));
  ({ TableStructureRecognizer, reconstructTable } = await import("./dist/table-ocr.js"));
  self.postMessage({ type: "ready" });
} catch (error) {
  self.postMessage({ type: "error", message: `Could not initialize PDF.js: ${error instanceof Error ? error.message : String(error)}` });
}

self.onmessage = async ({ data }) => {
  if (data.type !== "extract") return;
  try {
    self.postMessage({ type: "opening" });
    const loadingTask = pdfjs.getDocument({
      data: new Uint8Array(data.bytes),
      useWorkerFetch: false,
      CanvasFactory: WorkerCanvasFactory,
      FilterFactory: WorkerFilterFactory,
      disableFontFace: true,
      useSystemFonts: false,
      isOffscreenCanvasSupported: true,
    });
    const document = await loadingTask.promise;
    const detector = new DocLayoutDetector({
      modelUrl: new URL("./models/yolo26n_doc_layout_1280.onnx", import.meta.url).href,
      wasmPath: new URL("./dist/", import.meta.url).href,
      inputSize: 1280,
    });
    const pageCount = document.numPages;
    let mathRecognizer;
    let tableRecognizer;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      const transfers = [];
      const page = await document.getPage(pageNumber);
      const baseViewport = page.getViewport({ scale: 1 });
      const scale = 1280 / Math.max(baseViewport.width, baseViewport.height);
      const viewport = page.getViewport({ scale });
      const width = Math.max(1, Math.round(viewport.width));
      const height = Math.max(1, Math.round(viewport.height));
      const canvas = new OffscreenCanvas(width, height);
      const context = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
      await page.render({ canvasContext: context, viewport }).promise;
      const imageData = context.getImageData(0, 0, width, height);
      const detections = await detector.detect(imageData.data, width, height);
      const visuals = visualDetections(detections);
      const textRegions = detections.filter((region) => ["Text", "Title", "Section-header", "Caption", "Footnote", "List-item"].includes(region.label));
      const content = await page.getTextContent({ includeMarkedContent: false, disableNormalization: false });
      const tokens = pdfTokens(content, viewport, (fontName) => {
        try { return page.commonObjs?.has(fontName) ? page.commonObjs.get(fontName) : null; }
        catch { return null; }
      });
      let blocks = liftPdfTextRegions(tokens, textRegions, visuals);

      for (const visual of visuals) {
        const picturePadding = visual.label === "Picture" ? Math.min(16, Math.max(6, Math.round(Math.min(width, height) * 0.008))) : 0;
        const x = Math.max(0, Math.floor(visual.x1 - picturePadding));
        const y = Math.max(0, Math.floor(visual.y1 - picturePadding));
        const cropWidth = Math.max(1, Math.min(width - x, Math.ceil(visual.x2 + picturePadding) - x));
        const cropHeight = Math.max(1, Math.min(height - y, Math.ceil(visual.y2 + picturePadding) - y));
        const crop = new OffscreenCanvas(cropWidth, cropHeight);
        crop.getContext("2d").drawImage(canvas, x, y, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);
        let latex = "";
        let table = null;
        if (visual.label === "Formula") {
          mathRecognizer ||= new MathFormulaRecognizer({
            wasmPath: new URL("./dist/math-runtime/", import.meta.url).href,
            onProgress: (progress) => self.postMessage({ type: "math-progress", progress }),
          });
          try { latex = await mathRecognizer.recognize(crop); }
          catch (error) { self.postMessage({ type: "math-warning", message: error instanceof Error ? error.message : String(error) }); }
        }
        if (visual.label === "Table") {
          tableRecognizer ||= new TableStructureRecognizer({
            wasmPath: new URL("./dist/math-runtime/", import.meta.url).href,
            onProgress: (progress) => self.postMessage({ type: "table-progress", progress }),
          });
          try {
            const padded = padTableCanvas(crop);
            const virtualBox = { x1: x - padded.padX, y1: y - padded.padY, x2: x + cropWidth + padded.padX, y2: y + cropHeight + padded.padY };
            table = reconstructTable(await tableRecognizer.recognize(padded.canvas), tokens, virtualBox);
          }
          catch (error) { self.postMessage({ type: "table-warning", message: error instanceof Error ? error.message : String(error) }); }
        }
        const bytes = new Uint8Array(await (await crop.convertToBlob({ type: "image/png" })).arrayBuffer());
        blocks.push({ type: table ? "table" : "image", bytes, mime: "image/png", width: cropWidth, height: cropHeight, label: visual.label, latex, table, ...visual });
        transfers.push(bytes.buffer);
      }
      blocks = xyCut(blocks).map((block) => {
        const isPageNumber = block.type === "text" && /^(?:\d{1,4}|[ivxlcdm]{1,8})$/i.test(block.text.trim()) && (block.y1 <= height * 0.1 || block.y2 >= height * 0.9);
        const { x1, y1, x2, y2, ...clean } = block;
        return { ...clean, isPageNumber, layout: { x1, y1, x2, y2, pageWidth: width, pageHeight: height } };
      });
      const completedPage = { page: pageNumber, blocks };
      self.postMessage({ type: "page", page: completedPage, pageCount }, transfers);
      if (typeof page.cleanup === "function") page.cleanup();
      self.postMessage({ type: "progress", current: pageNumber, total: document.numPages });
    }
    if (typeof loadingTask.destroy === "function") await loadingTask.destroy();
    self.postMessage({ type: "result", format: "blocks", streamed: true, pageCount });
  } catch (error) {
    self.postMessage({ type: "error", message: error instanceof Error ? error.message : String(error) });
  }
};

function pdfTokens(content, viewport, fontLookup = () => null) {
  return content.items.flatMap((item, itemIndex) => {
    if (!item.str?.trim() || !item.transform) return [];
    const style = content.styles?.[item.fontName];
    const tx = pdfjs.Util.transform(viewport.transform, item.transform);
    const fontHeight = Math.hypot(tx[2], tx[3]) || Math.abs(tx[3]) || item.height || 1;
    const width = Math.max(1, Math.abs(item.width * viewport.scale));
    const angle = Math.atan2(tx[1], tx[0]);
    const advanceUnitX = Math.cos(angle);
    const advanceUnitY = Math.sin(angle);
    const normalUnitX = advanceUnitY;
    const normalUnitY = -advanceUnitX;
    const ascent = fontAscent(style, fontHeight);
    const descent = Math.max(0, fontHeight - ascent);
    const font = fontLookup(item.fontName);
    const fontDescription = [item.fontName, style?.fontFamily, font?.name, font?.loadedName, font?.fallbackName, font?.cssFontInfo?.fontFamily]
      .filter(Boolean)
      .join(" ");
    const itemBox = {
      text: item.str,
      width,
      fontSize: fontHeight,
      isBold: /(?:bold|black|heavy|semibold|demi)/i.test(fontDescription),
      isItalic: /(?:italic|oblique)/i.test(fontDescription),
      originX: tx[4], originY: tx[5], advanceUnitX, advanceUnitY,
      ascentX: normalUnitX * ascent, ascentY: normalUnitY * ascent,
      descentX: -normalUnitX * descent, descentY: -normalUnitY * descent,
      itemIndex,
      isHorizontal: Math.abs(Math.sin(angle)) <= 0.35,
    };
    return splitItemTokens(itemBox);
  });
}

function splitItemTokens(item) {
  const matches = [...item.text.matchAll(/\S+/g)];
  const totalCharacters = Math.max(1, item.text.length);
  return matches.map((match, tokenIndex) => {
    const startDistance = item.width * ((match.index || 0) / totalCharacters);
    const endDistance = item.width * (((match.index || 0) + match[0].length) / totalCharacters);
    const startX = item.originX + item.advanceUnitX * startDistance;
    const startY = item.originY + item.advanceUnitY * startDistance;
    const endX = item.originX + item.advanceUnitX * endDistance;
    const endY = item.originY + item.advanceUnitY * endDistance;
    const points = [
      [startX + item.ascentX, startY + item.ascentY], [endX + item.ascentX, endY + item.ascentY],
      [startX + item.descentX, startY + item.descentY], [endX + item.descentX, endY + item.descentY],
    ];
    return {
      text: match[0], itemIndex: item.itemIndex, tokenIndex, fontSize: item.fontSize, isBold: item.isBold, isItalic: item.isItalic, isHorizontal: item.isHorizontal,
      x1: Math.min(...points.map((point) => point[0])), y1: Math.min(...points.map((point) => point[1])),
      x2: Math.max(...points.map((point) => point[0])), y2: Math.max(...points.map((point) => point[1])),
    };
  });
}

function liftPdfTextRegions(tokens, regions, visuals) {
  const horizontal = tokens.filter((token) => token.isHorizontal && !visuals.some((visual) => containment(token, visual) >= 0.5));
  const claimed = new Set();
  const blocks = [];
  for (const region of regions) {
    const regionTokens = horizontal.filter((token) => !claimed.has(token) && containment(token, region) >= 0.35);
    if (!regionTokens.length) continue;
    regionTokens.forEach((token) => claimed.add(token));
    const rows = tokenRows(regionTokens);
    const characterCount = regionTokens.reduce((sum, token) => sum + token.text.length, 0);
    const boldCharacters = regionTokens.reduce((sum, token) => sum + (token.isBold ? token.text.length : 0), 0);
    const italicCharacters = regionTokens.reduce((sum, token) => sum + (token.isItalic ? token.text.length : 0), 0);
    blocks.push({
      type: "text", text: rows.map(joinRowTokens).join("\n"),
      isHorizontal: true,
      fontSize: regionTokens.reduce((sum, token) => sum + token.fontSize * token.text.length, 0) / Math.max(1, characterCount),
      isBold: boldCharacters / Math.max(1, characterCount) >= 0.5,
      isItalic: italicCharacters / Math.max(1, characterCount) >= 0.5,
      layoutLabel: region.label, x1: region.x1, y1: region.y1, x2: region.x2, y2: region.y2,
    });
  }
  for (const row of tokenRows(horizontal.filter((token) => !claimed.has(token)))) {
    blocks.push({
      type: "text", text: joinRowTokens(row), layoutLabel: "Text",
      isHorizontal: true,
      fontSize: row.reduce((sum, token) => sum + token.fontSize, 0) / row.length,
      isBold: row.filter((token) => token.isBold).length / row.length >= 0.5,
      isItalic: row.filter((token) => token.isItalic).length / row.length >= 0.5,
      x1: Math.min(...row.map((token) => token.x1)), y1: Math.min(...row.map((token) => token.y1)),
      x2: Math.max(...row.map((token) => token.x2)), y2: Math.max(...row.map((token) => token.y2)),
    });
  }
  return blocks;
}

function tokenRows(tokens) {
  const rows = [];
  for (const token of tokens.slice().sort((a, b) => centerY(a) - centerY(b) || a.y1 - b.y1 || a.x1 - b.x1)) {
    const row = rows.find((candidate) => Math.abs(centerY(token) - candidate.centerY) <= Math.max(2, Math.min(height(token), candidate.medianHeight) * 0.65) || verticalOverlap(token, candidate) >= 0.5);
    if (row) { row.tokens.push(token); updateRow(row); }
    else { const created = { tokens: [token] }; updateRow(created); rows.push(created); }
  }
  return rows.sort((a, b) => a.centerY - b.centerY || a.top - b.top).map((row) => row.tokens.sort((a, b) => a.x1 - b.x1 || a.itemIndex - b.itemIndex || a.tokenIndex - b.tokenIndex));
}

function joinRowTokens(tokens) {
  let text = "";
  let previous = null;
  for (const token of tokens) {
    if (previous) {
      const gap = token.x1 - previous.x2;
      const fontSize = Math.max(1, Math.min(previous.fontSize || 1, token.fontSize || 1));
      if (gap > fontSize * 0.16) text += " ";
    }
    text += token.text;
    previous = token;
  }
  return text;
}

function updateRow(row) {
  row.top = Math.min(...row.tokens.map((token) => token.y1));
  row.y1 = row.top;
  row.y2 = Math.max(...row.tokens.map((token) => token.y2));
  row.centerY = row.tokens.reduce((sum, token) => sum + centerY(token) * height(token), 0) / row.tokens.reduce((sum, token) => sum + height(token), 0);
  const heights = row.tokens.map(height).sort((a, b) => a - b);
  row.medianHeight = heights[Math.floor(heights.length / 2)];
}

function fontAscent(style, fontHeight) {
  if (Number.isFinite(style?.ascent) && style.ascent * fontHeight > fontHeight * 0.15) return style.ascent * fontHeight;
  if (Number.isFinite(style?.descent) && (1 + style.descent) * fontHeight > fontHeight * 0.15) return (1 + style.descent) * fontHeight;
  return fontHeight;
}

function containment(inner, outer) {
  const intersection = Math.max(0, Math.min(inner.x2, outer.x2) - Math.max(inner.x1, outer.x1)) * Math.max(0, Math.min(inner.y2, outer.y2) - Math.max(inner.y1, outer.y1));
  return intersection / Math.max(1, (inner.x2 - inner.x1) * (inner.y2 - inner.y1));
}

const centerY = (item) => (item.y1 + item.y2) / 2;
const height = (item) => Math.max(1, item.y2 - item.y1);
function verticalOverlap(left, right) {
  const overlap = Math.max(0, Math.min(left.y2, right.y2) - Math.max(left.y1, right.y1));
  return overlap / Math.max(1, Math.min(height(left), height(right)));
}

function padTableCanvas(source) {
  const padX = Math.min(48, Math.max(12, Math.round(source.width * 0.04)));
  const padY = Math.min(48, Math.max(12, Math.round(source.height * 0.1)));
  const canvas = new OffscreenCanvas(source.width + padX * 2, source.height + padY * 2);
  const context = canvas.getContext("2d");
  context.fillStyle = "white";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(source, padX, padY);
  return { canvas, padX, padY };
}

class WorkerCanvasFactory {
  create(width, height) {
    if (width <= 0 || height <= 0) throw new Error("Invalid canvas size");
    const canvas = new OffscreenCanvas(width, height);
    return { canvas, context: canvas.getContext("2d") };
  }

  reset(target, width, height) {
    if (!target?.canvas) throw new Error("Canvas is not specified");
    if (width <= 0 || height <= 0) throw new Error("Invalid canvas size");
    target.canvas.width = width;
    target.canvas.height = height;
  }

  destroy(target) {
    if (!target?.canvas) return;
    target.canvas.width = 0;
    target.canvas.height = 0;
    target.canvas = null;
    target.context = null;
  }
}

class WorkerFilterFactory {
  addFilter() { return "none"; }
  addHCMFilter() { return "none"; }
  addAlphaFilter() { return "none"; }
  addLuminosityFilter() { return "none"; }
  addKnockoutFilter() { return "none"; }
  addHighlightHCMFilter() { return "none"; }
  addSelectionHCMFilter() { return "none"; }
  addSelectionFilter() { return "none"; }
  createSelectionStyle() { return null; }
  destroy() {}
}
