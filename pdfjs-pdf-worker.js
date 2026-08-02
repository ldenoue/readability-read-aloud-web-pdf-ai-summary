let pdfjs;
let DocLayoutDetector;
let visualDetections;
let xyCut;
let MathFormulaRecognizer;
let TableStructureRecognizer;
let reconstructTable;
const PDF_RENDER_SCALE = 2;

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
      const viewport = page.getViewport({ scale: PDF_RENDER_SCALE });
      const width = Math.max(1, Math.round(viewport.width));
      const height = Math.max(1, Math.round(viewport.height));
      const canvas = new OffscreenCanvas(width, height);
      const context = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
      await page.render({ canvasContext: context, viewport }).promise;
      const imageData = context.getImageData(0, 0, width, height);
      const detections = await detector.detect(imageData.data, width, height);
      let visuals = visualDetections(detections);
      const textRegions = detections.filter((region) => ["Text", "Title", "Section-header", "Caption", "Footnote", "List-item"].includes(region.label));
      const content = await page.getTextContent({ includeMarkedContent: false, disableNormalization: false });
      const tokens = pdfTokens(content, viewport, (fontName) => {
        try { return page.commonObjs?.has(fontName) ? page.commonObjs.get(fontName) : null; }
        catch { return null; }
      });
      // YOLO occasionally labels a single inline radical as a Formula. Keep
      // the positioned PDF glyph in that case; treating it as a visual would
      // remove it from the sentence and create a detached OCR formula block.
      visuals = visuals.filter((visual) => !isInlinePdfMathDetection(visual, tokens));
      let blocks = liftPdfTextRegions(tokens, textRegions, visuals);

      for (const visual of visuals) {
        const picturePadding = visual.label === "Picture" ? Math.min(16, Math.max(6, Math.round(Math.min(width, height) * 0.008))) : 0;
        const x = Math.max(0, Math.floor(visual.x1 - picturePadding));
        const y = Math.max(0, Math.floor(visual.y1 - picturePadding));
        const cropWidth = Math.max(1, Math.min(width - x, Math.ceil(visual.x2 + picturePadding) - x));
        const cropHeight = Math.max(1, Math.min(height - y, Math.ceil(visual.y2 + picturePadding) - y));
        let crop = new OffscreenCanvas(cropWidth, cropHeight);
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
        if (visual.label === "Picture") crop = trimWhiteCanvas(crop);
        const bytes = table ? null : new Uint8Array(await (await crop.convertToBlob({ type: "image/png" })).arrayBuffer());
        blocks.push({ type: table ? "table" : "image", ...(bytes ? { bytes, mime: "image/png" } : {}), width: crop.width, height: crop.height, label: visual.label, latex, table, ...visual });
        if (bytes) transfers.push(bytes.buffer);
      }
      blocks = xyCut(blocks).map((block) => {
        const isPageNumber = block.type === "text" && /^(?:\d{1,4}|[ivxlcdm]{1,8})$/i.test(block.text.trim())
          && (block.y1 <= height * 0.1 || block.y2 >= height * 0.82);
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
  const unicodeOffsets = shiftedPdfFontUnicodeOffsets(content);
  return content.items.flatMap((item, itemIndex) => {
    const itemText = decodeShiftedPdfText(item.str, unicodeOffsets.get(item.fontName) || 0);
    if (!itemText?.trim() || !item.transform) return [];
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
      text: itemText,
      width,
      fontSize: fontHeight,
      isBold: /(?:bold|black|heavy|semibold|demi|nimbusromno9l[-_](?:medi|medium)(?:ital)?)/i.test(fontDescription),
      isItalic: /(?:italic|oblique)/i.test(fontDescription),
      isMath: /(?:cambria\s*math|stix|mathjax|latinmodernmath|texgyre.*math|(?:^|[+\s_-])(?:cmmi|cmsy|cmex|msam|msbm|stmary|rsfs|eufm|symbol|mathematicalpi)\d*(?:$|[+\s_-]))/i.test(fontDescription),
      originX: tx[4], originY: tx[5], advanceUnitX, advanceUnitY,
      ascentX: normalUnitX * ascent, ascentY: normalUnitY * ascent,
      descentX: -normalUnitX * descent, descentY: -normalUnitY * descent,
      itemIndex,
      isHorizontal: Math.abs(Math.sin(angle)) <= 0.35,
    };
    return splitItemTokens(itemBox);
  });
}

function shiftedPdfFontUnicodeOffsets(content) {
  const samples = new Map();
  for (const item of content.items || []) {
    if (!item.fontName || !item.str) continue;
    samples.set(item.fontName, `${samples.get(item.fontName) || ""}${item.str}`);
  }
  const offsets = new Map();
  for (const [fontName, sample] of samples) {
    if (sample.length < 12) continue;
    const controlCounts = new Map();
    for (const character of sample) {
      const code = character.codePointAt(0);
      if (code > 0 && code < 32) controlCounts.set(code, (controlCounts.get(code) || 0) + 1);
    }
    if ([...controlCounts.values()].reduce((sum, count) => sum + count, 0) < 2) continue;
    const candidates = [...controlCounts].sort((left, right) => right[1] - left[1]);
    for (const [spaceCode] of candidates) {
      const offset = 32 - spaceCode;
      if (offset <= 0 || offset > 64) continue;
      const decoded = decodeShiftedPdfText(sample, offset);
      const characters = [...decoded];
      const printable = characters.filter((character) => {
        const code = character.codePointAt(0);
        return code >= 32 && code <= 126;
      }).length;
      const letters = characters.filter((character) => /[A-Za-z]/u.test(character)).length;
      const spaces = characters.filter((character) => character === " ").length;
      if (printable / characters.length >= 0.97 && letters / characters.length >= 0.45 && spaces >= 2) {
        offsets.set(fontName, offset);
        break;
      }
    }
  }
  return offsets;
}

function decodeShiftedPdfText(text, offset) {
  if (!offset || !text) return text || "";
  let decoded = [...text].map((character) => {
    // Some custom single-byte fonts expose their encoded opening-parenthesis
    // glyph as a normalized space even though the rest of the font follows a
    // constant Unicode offset.
    if (offset === 29 && character === " ") return "(";
    return String.fromCodePoint(character.codePointAt(0) + offset);
  }).join("");
  if (offset === 29 && decoded.lastIndexOf("(") > decoded.lastIndexOf(")") && /[\p{L}\p{N}]$/u.test(decoded)) decoded += ")";
  return decoded;
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
      text: match[0], itemIndex: item.itemIndex, tokenIndex, fontSize: item.fontSize, baselineY: startY, isBold: item.isBold, isItalic: item.isItalic, isMath: item.isMath, isHorizontal: item.isHorizontal,
      x1: Math.min(...points.map((point) => point[0])), y1: Math.min(...points.map((point) => point[1])),
      x2: Math.max(...points.map((point) => point[0])), y2: Math.max(...points.map((point) => point[1])),
    };
  });
}

function isInlinePdfMathDetection(visual, tokens) {
  if (visual.label !== "Formula") return false;
  const nearby = tokens.filter((token) => containment(token, visual) >= 0.15
    || ((token.x1 + token.x2) / 2 >= visual.x1 && (token.x1 + token.x2) / 2 <= visual.x2
      && centerY(token) >= visual.y1 && centerY(token) <= visual.y2));
  const radical = nearby.find((token) => /[√∛∜]/u.test(token.text));
  if (!radical || visual.x2 - visual.x1 > radical.fontSize * 4.5) return false;

  const adjacent = tokens.filter((token) => token !== radical
    && Math.abs(token.itemIndex - radical.itemIndex) <= 2
    && Math.abs(token.baselineY - radical.baselineY) <= radical.fontSize * 1.2);
  return adjacent.some((token) => token.itemIndex < radical.itemIndex && token.x1 <= radical.x1)
    && adjacent.some((token) => token.itemIndex > radical.itemIndex && token.x2 >= radical.x2);
}

function liftPdfTextRegions(tokens, regions, visuals) {
  // Layout boxes hug the visible formula body, while PDF text glyph boxes for
  // radicals, scalable delimiters, scripts, and equation numbers often extend
  // just beyond it. Use a padded box only for suppressing duplicate text; keep
  // the original detection unchanged for cropping and math recognition.
  const textExclusions = visuals.map((visual) => {
    if (visual.label !== "Formula") return visual;
    const visualHeight = Math.max(1, visual.y2 - visual.y1);
    const padX = Math.max(12, Math.min(48, visualHeight * 0.75));
    const padY = Math.max(8, Math.min(28, visualHeight * 0.35));
    return { ...visual, x1: visual.x1 - padX, y1: visual.y1 - padY, x2: visual.x2 + padX, y2: visual.y2 + padY };
  });
  const horizontal = tokens.filter((token) => {
    if (!token.isHorizontal) return false;
    const protectedInlineMath = isProtectedInlineMathToken(token, tokens, regions);
    return protectedInlineMath || !textExclusions.some((visual) => containment(token, visual) >= 0.35);
  });
  const regionAssignments = new Map(horizontal.map((token) => [token, bestTextRegion(token, regions)]));
  const claimed = new Set();
  const blocks = [];
  for (const region of regions) {
    const regionTokens = horizontal.filter((token) => !claimed.has(token) && regionAssignments.get(token) === region);
    if (!regionTokens.length) continue;
    regionTokens.forEach((token) => claimed.add(token));
    const dropCap = pdfDropCapToken(regionTokens, region);
    const rows = tokenRows(dropCap ? regionTokens.filter((token) => token !== dropCap) : regionTokens);
    const characterCount = regionTokens.reduce((sum, token) => sum + token.text.length, 0);
    const boldCharacters = regionTokens.reduce((sum, token) => sum + (token.isBold ? token.text.length : 0), 0);
    const italicCharacters = regionTokens.reduce((sum, token) => sum + (token.isItalic ? token.text.length : 0), 0);
    blocks.push({
      type: "text", text: `${dropCap ? joinRowTokens([dropCap]) : ""}${rows.map(joinRowTokens).join("\n")}`,
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

function pdfDropCapToken(tokens, region) {
  if (region?.label !== "Text" || tokens.length < 4) return null;
  const ordered = tokens.slice().sort((left, right) => left.itemIndex - right.itemIndex || left.tokenIndex - right.tokenIndex);
  const candidate = ordered[0];
  if (candidate.isMath || !/^\p{L}$/u.test(candidate.text)) return null;
  const remaining = tokens.filter((token) => token !== candidate);
  const fontSizes = remaining.map((token) => token.fontSize).sort((left, right) => left - right);
  const bodyFontSize = fontSizes[Math.floor(fontSizes.length / 2)] || 0;
  if (!(bodyFontSize > 0) || candidate.fontSize < bodyFontSize * 2.5) return null;
  const leftEdge = Math.min(...tokens.map((token) => token.x1));
  if (candidate.x1 > leftEdge + bodyFontSize * 0.75) return null;
  const nearbyLines = remaining.filter((token) => centerY(token) >= candidate.y1 && centerY(token) <= candidate.y2);
  return new Set(nearbyLines.map((token) => Math.round(token.baselineY / Math.max(1, bodyFontSize * 0.5)))).size >= 2
    ? candidate
    : null;
}

function isProtectedInlineMathToken(token, tokens, regions) {
  if (!/[√∛∜]/u.test(token.text) || !regions.some((region) => tokenBelongsToTextRegion(token, region))) return false;
  const adjacent = tokens.filter((candidate) => candidate !== token
    && Math.abs(candidate.itemIndex - token.itemIndex) <= 2
    && Math.abs(candidate.baselineY - token.baselineY) <= token.fontSize * 1.2);
  return adjacent.some((candidate) => candidate.itemIndex < token.itemIndex && candidate.x1 <= token.x1)
    && adjacent.some((candidate) => candidate.itemIndex > token.itemIndex && candidate.x2 >= token.x2);
}

function bestTextRegion(token, regions) {
  return regions.filter((region) => tokenBelongsToTextRegion(token, region))
    .sort((left, right) => textRegionAffinity(token, right) - textRegionAffinity(token, left))[0] || null;
}

function textRegionAffinity(token, region) {
  const overlapScore = containment(token, region) * 100;
  const centerX = (token.x1 + token.x2) / 2;
  const center = centerY(token);
  const dx = centerX < region.x1 ? region.x1 - centerX : centerX > region.x2 ? centerX - region.x2 : 0;
  const dy = center < region.y1 ? region.y1 - center : center > region.y2 ? center - region.y2 : 0;
  return overlapScore - Math.hypot(dx, dy) / Math.max(1, token.fontSize);
}

function tokenBelongsToTextRegion(token, region) {
  if (containment(token, region) >= 0.35) return true;
  const isMathAuxiliary = token.isMath || /[√∛∜∫∮∑∏]/u.test(token.text);
  if (!isMathAuxiliary) return false;

  // TeX radicals and scalable operators commonly have an origin/baseline well
  // outside their visible ink. YOLO still groups them with the prose line, but
  // their PDF.js box can miss the detected Text rectangle. Associate such a
  // glyph with a nearby region using its horizontal position and a font-sized
  // vertical allowance; its x coordinate can then order it within the row.
  const centerX = (token.x1 + token.x2) / 2;
  const horizontalAllowance = Math.max(2, token.fontSize * 0.4);
  const verticalAllowance = Math.max(3, token.fontSize * 1.15);
  return centerX >= region.x1 - horizontalAllowance
    && centerX <= region.x2 + horizontalAllowance
    && token.y2 >= region.y1 - verticalAllowance
    && token.y1 <= region.y2 + verticalAllowance;
}

function tokenRows(tokens) {
  const ordered = tokens.slice().sort((a, b) => centerY(a) - centerY(b) || a.y1 - b.y1 || a.x1 - b.x1);
  const fontSizes = ordered.map((token) => token.fontSize).sort((a, b) => a - b);
  const medianFontSize = fontSizes[Math.floor(fontSizes.length / 2)] || 1;
  const isAuxiliary = (token) => token.isMath
    || /[√∛∜∫∮∑∏]/u.test(token.text)
    || token.fontSize <= medianFontSize * 0.88;
  const primary = ordered.filter((token) => !isAuxiliary(token));
  const auxiliary = ordered.filter(isAuxiliary);
  const rows = [];
  for (const token of primary.length ? primary : ordered) {
    const candidates = rows.filter((candidate) => Math.abs(token.baselineY - candidate.medianBaseline) <= Math.max(token.fontSize, candidate.medianFontSize) * 0.38
      && Math.abs(centerY(token) - candidate.centerY) <= Math.max(2, Math.min(height(token), candidate.medianHeight) * 0.72));
    const row = candidates.sort((left, right) => rowTokenAffinity(token, left) - rowTokenAffinity(token, right))[0];
    if (row) { row.tokens.push(token); updateRow(row); }
    else { const created = { tokens: [token] }; updateRow(created); rows.push(created); }
  }
  if (primary.length) {
    for (const token of auxiliary) {
      const mathAuxiliary = token.isMath || /[√∛∜∫∮∑∏]/u.test(token.text);
      const baselineAllowance = mathAuxiliary ? 1.05 : 0.55;
      const candidates = rows.filter((candidate) => Math.abs(token.baselineY - candidate.medianBaseline)
        <= Math.max(token.fontSize, candidate.medianFontSize) * baselineAllowance);
      // Math fonts can report baselines far outside their visible glyphs, so
      // retain the content-order fallback used for radicals and operators.
      // Ordinary small text must remain close to a primary baseline; otherwise
      // it is a separate line such as an affiliation beneath an author name.
      const eligibleRows = candidates.length ? candidates : mathAuxiliary ? rows : [];
      const row = eligibleRows.slice().sort((left, right) => auxiliaryRowAffinity(token, left) - auxiliaryRowAffinity(token, right))[0];
      if (row) { row.tokens.push(token); updateRow(row); }
      else { const created = { tokens: [token] }; updateRow(created); rows.push(created); }
    }
  }
  return rows.sort((a, b) => a.centerY - b.centerY || a.top - b.top).map((row) => row.tokens.sort((a, b) => a.x1 - b.x1 || a.itemIndex - b.itemIndex || a.tokenIndex - b.tokenIndex));
}

function rowTokenAffinity(token, row) {
  const fontSize = Math.max(1, token.fontSize, row.medianFontSize);
  const baselineDistance = Math.abs(token.baselineY - row.medianBaseline) / fontSize;
  const centerDistance = Math.abs(centerY(token) - row.centerY) / Math.max(1, Math.min(height(token), row.medianHeight));
  const horizontalDistance = token.x2 < row.left ? row.left - token.x2 : token.x1 > row.right ? token.x1 - row.right : 0;
  return baselineDistance * 4 + centerDistance + horizontalDistance / fontSize * 0.08;
}

function auxiliaryRowAffinity(token, row) {
  // PDF content order remains reliable for many TeX glyphs whose reported
  // baseline does not. A radical normally sits between the adjacent `i` and
  // radicand items, so prefer the row containing neighboring item indices.
  const sequenceDistance = Math.min(...row.tokens.map((candidate) => Math.abs(candidate.itemIndex - token.itemIndex)));
  return rowTokenAffinity(token, row) + sequenceDistance * 2;
}

function joinRowTokens(tokens) {
  tokens = repairCombiningOverlayOrder(tokens);
  const fontSizes = tokens.map((token) => token.fontSize).sort((a, b) => a - b);
  const medianFontSize = fontSizes[Math.floor(fontSizes.length / 2)] || 1;
  const normalTokens = tokens.filter((token) => token.fontSize >= medianFontSize * 0.9);
  const baselines = (normalTokens.length ? normalTokens : tokens).map((token) => token.baselineY).sort((a, b) => a - b);
  const baseline = baselines[Math.floor(baselines.length / 2)] || 0;
  let text = "";
  let previous = null;
  for (const token of tokens) {
    if (previous) {
      const gap = token.x1 - previous.x2;
      const fontSize = Math.max(1, Math.min(previous.fontSize || 1, token.fontSize || 1));
      if (gap > fontSize * 0.16) text += " ";
    }
    const isSuperscript = token.fontSize <= medianFontSize * 0.85
      && token.baselineY <= baseline - medianFontSize * 0.12;
    const isSubscript = token.fontSize <= medianFontSize * 0.88
      && token.baselineY >= baseline + medianFontSize * 0.12;
    let tokenText = token.isMath ? `\uE104${token.text}\uE105` : token.text;
    if (token.isBold) tokenText = `\uE106${tokenText}\uE107`;
    if (isSuperscript) tokenText = `\uE100${tokenText}\uE101`;
    else if (isSubscript) tokenText = `\uE102${tokenText}\uE103`;
    text += tokenText;
    previous = token;
  }
  return text;
}

function repairCombiningOverlayOrder(tokens) {
  const repaired = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    const next = tokens[index + 1];
    // Some embedded math fonts expose a rendered negated operator as a
    // zero-width U+0338 glyph followed by its base operator at the same x
    // position. Put the base first so Unicode normalization can compose, for
    // example, PDF.js's "\u0338" + "=" into the rendered "≠".
    if (token.text === "\u0338" && next) {
      const tolerance = Math.max(1, token.fontSize, next.fontSize) * 0.2;
      if (Math.abs(token.x1 - next.x1) <= tolerance) {
        repaired.push({ ...next, text: `${next.text}\u0338`.normalize("NFC") });
        index++;
        continue;
      }
    }
    // A few TeX fonts map that same slash glyph to the character code for
    // "6" in PDF.js's text layer. It is distinguishable from a real six
    // because its box is painted on top of the equals sign, not before it.
    if (token.text === "6" && next?.text.startsWith("=")) {
      const overlap = Math.max(0, Math.min(token.x2, next.x2) - Math.max(token.x1, next.x1));
      const narrowerWidth = Math.max(1, Math.min(token.x2 - token.x1, next.x2 - next.x1));
      const sameBaseline = Math.abs(token.baselineY - next.baselineY) <= Math.max(token.fontSize, next.fontSize) * 0.2;
      if (overlap / narrowerWidth >= 0.6 && sameBaseline) {
        repaired.push({ ...next, text: `≠${next.text.slice(1)}` });
        index++;
        continue;
      }
    }
    repaired.push(token);
  }
  return repaired;
}

function updateRow(row) {
  row.top = Math.min(...row.tokens.map((token) => token.y1));
  row.y1 = row.top;
  row.y2 = Math.max(...row.tokens.map((token) => token.y2));
  row.left = Math.min(...row.tokens.map((token) => token.x1));
  row.right = Math.max(...row.tokens.map((token) => token.x2));
  row.centerY = row.tokens.reduce((sum, token) => sum + centerY(token) * height(token), 0) / row.tokens.reduce((sum, token) => sum + height(token), 0);
  const heights = row.tokens.map(height).sort((a, b) => a - b);
  row.medianHeight = heights[Math.floor(heights.length / 2)];
  const baselines = row.tokens.map((token) => token.baselineY).sort((a, b) => a - b);
  const fontSizes = row.tokens.map((token) => token.fontSize).sort((a, b) => a - b);
  row.medianBaseline = baselines[Math.floor(baselines.length / 2)];
  row.medianFontSize = fontSizes[Math.floor(fontSizes.length / 2)];
}

function fontAscent(style, fontHeight) {
  if (Number.isFinite(style?.ascent) && style.ascent * fontHeight > fontHeight * 0.15) return style.ascent * fontHeight;
  if (Number.isFinite(style?.descent) && (1 + style.descent) * fontHeight > fontHeight * 0.15) return (1 + style.descent) * fontHeight;
  return fontHeight;
}

function nonWhitePixelBounds(data, width, height, threshold = 250) {
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      if (data[offset] >= threshold && data[offset + 1] >= threshold && data[offset + 2] >= threshold) continue;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
  }
  return right >= left && bottom >= top
    ? { x: left, y: top, width: right - left + 1, height: bottom - top + 1 }
    : null;
}

function trimWhiteCanvas(source) {
  const context = source.getContext("2d", { willReadFrequently: true });
  const bounds = nonWhitePixelBounds(context.getImageData(0, 0, source.width, source.height).data, source.width, source.height);
  if (!bounds || (bounds.x === 0 && bounds.y === 0 && bounds.width === source.width && bounds.height === source.height)) return source;
  const trimmed = new OffscreenCanvas(bounds.width, bounds.height);
  trimmed.getContext("2d").drawImage(source, bounds.x, bounds.y, bounds.width, bounds.height, 0, 0, bounds.width, bounds.height);
  return trimmed;
}

function containment(inner, outer) {
  const intersection = Math.max(0, Math.min(inner.x2, outer.x2) - Math.max(inner.x1, outer.x1)) * Math.max(0, Math.min(inner.y2, outer.y2) - Math.max(inner.y1, outer.y1));
  return intersection / Math.max(1, (inner.x2 - inner.x1) * (inner.y2 - inner.y1));
}

const centerY = (item) => (item.y1 + item.y2) / 2;
const height = (item) => Math.max(1, item.y2 - item.y1);

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
