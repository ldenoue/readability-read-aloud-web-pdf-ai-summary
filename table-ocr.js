import { env, pipeline, RawImage } from "@huggingface/transformers";

const MODEL = "Xenova/table-transformer-structure-recognition";

export class TableStructureRecognizer {
  constructor({ wasmPath, onProgress } = {}) {
    env.allowLocalModels = false;
    env.useBrowserCache = true;
    env.backends.onnx.wasm.proxy = false;
    if (wasmPath) env.backends.onnx.wasm.wasmPaths = wasmPath;
    this.onProgress = onProgress;
    this.ready = null;
  }

  async load() {
    this.ready ||= pipeline("object-detection", MODEL, {
      dtype: "q8",
      device: "wasm",
      progress_callback: (progress) => this.onProgress?.(progress),
    });
    return this.ready;
  }

  async recognize(canvas) {
    const detector = await this.load();
    const image = canvas.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height);
    const raw = new RawImage(image.data, image.width, image.height, 4);
    return detector(raw, { threshold: 0.35, percentage: false });
  }
}

export function reconstructTable(detections, tokens, tableBox) {
  const normalized = detections.map((item) => ({
    label: String(item.label || "").toLowerCase(),
    score: item.score || 0,
    x1: item.box?.xmin ?? item.box?.x1 ?? 0,
    y1: item.box?.ymin ?? item.box?.y1 ?? 0,
    x2: item.box?.xmax ?? item.box?.x2 ?? 0,
    y2: item.box?.ymax ?? item.box?.y2 ?? 0,
  }));
  const rows = normalized.filter((item) => item.label === "table row").sort((a, b) => centerY(a) - centerY(b));
  const columns = normalized.filter((item) => item.label === "table column").sort((a, b) => centerX(a) - centerX(b));
  const headers = normalized.filter((item) => item.label === "table column header");
  if (!rows.length || !columns.length) return null;
  const localTokens = tokens.filter((token) => centerX(token) >= tableBox.x1 && centerX(token) <= tableBox.x2 && centerY(token) >= tableBox.y1 && centerY(token) <= tableBox.y2)
    .map((token) => ({ ...token, cx: centerX(token) - tableBox.x1, cy: centerY(token) - tableBox.y1 }));
  const outputRows = rows.map((row) => ({
    cells: columns.map((column) => {
      const cellTokens = localTokens.filter((token) => token.cx >= column.x1 && token.cx <= column.x2 && token.cy >= row.y1 && token.cy <= row.y2)
        .sort((a, b) => a.y1 - b.y1 || a.x1 - b.x1);
      return {
        text: joinTokens(cellTokens),
        header: headers.some((header) => overlapRatio({ x1: column.x1, y1: row.y1, x2: column.x2, y2: row.y2 }, header) >= 0.5),
      };
    }),
  }));
  return { rows: outputRows, columns: columns.length };
}

function joinTokens(tokens) {
  return tokens.map((token) => token.text).join(" ").replace(/\s+([,.;:!?%)\]])/g, "$1").trim();
}

function overlapRatio(left, right) {
  const area = Math.max(0, Math.min(left.x2, right.x2) - Math.max(left.x1, right.x1)) * Math.max(0, Math.min(left.y2, right.y2) - Math.max(left.y1, right.y1));
  return area / Math.max(1, (left.x2 - left.x1) * (left.y2 - left.y1));
}

const centerX = (item) => (item.x1 + item.x2) / 2;
const centerY = (item) => (item.y1 + item.y2) / 2;
