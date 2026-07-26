import * as ort from "onnxruntime-web/wasm";

export const LAYOUT_CLASSES = ["Caption", "Footnote", "Formula", "List-item", "Page-footer", "Page-header", "Picture", "Section-header", "Table", "Text", "Title"];
const VISUAL_CLASSES = new Set(["Formula", "Picture", "Table"]);

export class DocLayoutDetector {
  constructor({ modelUrl, wasmPath, inputSize = 1280 }) {
    this.modelUrl = modelUrl;
    this.inputSize = inputSize;
    ort.env.wasm.wasmPaths = wasmPath;
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.proxy = false;
  }

  async load() {
    this.session ||= await ort.InferenceSession.create(this.modelUrl, {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all",
    });
    return this.session;
  }

  async detect(rgba, width, height, confidence = 0.2) {
    const session = await this.load();
    const source = new OffscreenCanvas(width, height);
    source.getContext("2d").putImageData(new ImageData(rgba, width, height), 0, 0);
    const input = new OffscreenCanvas(this.inputSize, this.inputSize);
    const context = input.getContext("2d", { willReadFrequently: true });
    const scale = Math.min(this.inputSize / width, this.inputSize / height);
    const drawWidth = width * scale;
    const drawHeight = height * scale;
    const offsetX = (this.inputSize - drawWidth) / 2;
    const offsetY = (this.inputSize - drawHeight) / 2;
    context.fillStyle = "rgb(124,124,124)";
    context.fillRect(0, 0, this.inputSize, this.inputSize);
    context.drawImage(source, offsetX, offsetY, drawWidth, drawHeight);
    const pixels = context.getImageData(0, 0, this.inputSize, this.inputSize).data;
    const plane = this.inputSize * this.inputSize;
    const channels = new Float32Array(plane * 3);
    for (let index = 0; index < plane; index++) {
      channels[index] = pixels[index * 4] / 255;
      channels[plane + index] = pixels[index * 4 + 1] / 255;
      channels[plane * 2 + index] = pixels[index * 4 + 2] / 255;
    }
    const tensor = new ort.Tensor("float32", channels, [1, 3, this.inputSize, this.inputSize]);
    const output = await session.run({ [session.inputNames[0]]: tensor });
    tensor.dispose?.();
    const value = output.output0 || output[Object.keys(output)[0]];
    const stride = value.dims[value.dims.length - 1] || 6;
    const count = value.dims[value.dims.length - 2] || Math.floor(value.data.length / stride);
    const detections = [];
    for (let index = 0; index < count; index++) {
      const start = index * stride;
      const score = Number(value.data[start + 4]);
      if (score < confidence) continue;
      const cls = Math.round(value.data[start + 5]);
      const label = LAYOUT_CLASSES[cls] || `class_${cls}`;
      const x1 = clamp((value.data[start] - offsetX) / scale, 0, width);
      const y1 = clamp((value.data[start + 1] - offsetY) / scale, 0, height);
      const x2 = clamp((value.data[start + 2] - offsetX) / scale, 0, width);
      const y2 = clamp((value.data[start + 3] - offsetY) / scale, 0, height);
      if (x2 > x1 && y2 > y1) detections.push({ label, cls, score, x1, y1, x2, y2 });
    }
    value.dispose?.();
    const contentDetections = detections.filter((item) => !["Page-footer", "Page-header"].includes(item.label));
    return xyCut(keepOuterDetections(contentDetections));
  }
}

export const visualDetections = (detections) => detections.filter((item) => VISUAL_CLASSES.has(item.label));

export function keepOuterDetections(detections, containmentThreshold = 0.9) {
  const ordered = detections
    .filter((item) => item.x2 > item.x1 && item.y2 > item.y1)
    .slice()
    .sort((left, right) => area(right) - area(left) || right.score - left.score);
  const kept = [];
  for (const candidate of ordered) {
    if (kept.some((outer) => containment(candidate, outer) >= containmentThreshold)) continue;
    kept.push(candidate);
  }
  return kept;
}

export function liftTextRegions(lines, regions, visuals) {
  const assignments = new Map(regions.map((region) => [region, []]));
  const unassigned = [];
  for (const line of lines) {
    if (visuals.some((visual) => containment(line, visual) >= 0.5)) continue;
    let bestRegion = null;
    let bestOverlap = 0;
    for (const region of regions) {
      const overlap = containment(line, region);
      const centerInside = (line.x1 + line.x2) / 2 >= region.x1 && (line.x1 + line.x2) / 2 <= region.x2
        && (line.y1 + line.y2) / 2 >= region.y1 && (line.y1 + line.y2) / 2 <= region.y2;
      const score = overlap + (centerInside ? 0.35 : 0);
      if (score > bestOverlap) { bestOverlap = score; bestRegion = region; }
    }
    if (bestRegion && bestOverlap >= 0.45) assignments.get(bestRegion).push(line);
    else unassigned.push(line);
  }
  const blocks = [];
  for (const region of regions) {
    const regionLines = assignments.get(region).sort(readingOrder);
    if (!regionLines.length) continue;
    const characterCount = regionLines.reduce((sum, line) => sum + line.text.length, 0);
    blocks.push({
      type: "text",
      text: regionLines.map((line) => line.text).join("\n"),
      fontSize: regionLines.reduce((sum, line) => sum + line.fontSize * line.text.length, 0) / Math.max(1, characterCount),
      layoutLabel: region.label,
      x1: region.x1, y1: region.y1, x2: region.x2, y2: region.y2,
    });
  }
  for (const line of unassigned) blocks.push({ type: "text", layoutLabel: "Text", ...line });
  return blocks;
}

export function xyCut(items, minGapX = 4, minGapY = 16) {
  return xyCutRecursive(items.slice(), minGapX, minGapY);
}

function xyCutRecursive(items, minGapX, minGapY) {
  if (items.length <= 1) return items;
  const horizontal = bestCut(items, "y", minGapY);
  const vertical = bestCut(items, "x", minGapX);
  const cut = !horizontal ? vertical : !vertical ? horizontal : horizontal.gap >= vertical.gap ? horizontal : vertical;
  if (!cut) return items.sort(readingOrder);
  return [...xyCutRecursive(cut.before, minGapX, minGapY), ...xyCutRecursive(cut.after, minGapX, minGapY)];
}

function bestCut(items, axis, minimumGap) {
  const start = axis === "x" ? "x1" : "y1";
  const end = axis === "x" ? "x2" : "y2";
  const sorted = items.slice().sort((a, b) => a[start] - b[start]);
  let maximumEnd = sorted[0][end];
  let best = null;
  for (let index = 1; index < sorted.length; index++) {
    const gap = sorted[index][start] - maximumEnd;
    if (gap >= minimumGap && (!best || gap > best.gap)) {
      const cut = (sorted[index][start] + maximumEnd) / 2;
      const before = items.filter((item) => (item[start] + item[end]) / 2 < cut);
      const after = items.filter((item) => (item[start] + item[end]) / 2 >= cut);
      if (before.length && after.length) best = { gap, before, after };
    }
    maximumEnd = Math.max(maximumEnd, sorted[index][end]);
  }
  return best;
}

function readingOrder(left, right) {
  const tolerance = Math.max(8, Math.min(left.y2 - left.y1, right.y2 - right.y1) * 0.35);
  const leftCenter = (left.y1 + left.y2) / 2;
  const rightCenter = (right.y1 + right.y2) / 2;
  return Math.abs(leftCenter - rightCenter) > tolerance ? leftCenter - rightCenter : left.x1 - right.x1;
}

function containment(inner, outer) {
  const intersection = Math.max(0, Math.min(inner.x2, outer.x2) - Math.max(inner.x1, outer.x1))
    * Math.max(0, Math.min(inner.y2, outer.y2) - Math.max(inner.y1, outer.y1));
  return intersection / Math.max(1, (inner.x2 - inner.x1) * (inner.y2 - inner.y1));
}

const area = (item) => Math.max(0, item.x2 - item.x1) * Math.max(0, item.y2 - item.y1);

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
