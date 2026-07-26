import { env, PreTrainedTokenizer, Tensor, VisionEncoderDecoderModel } from "@huggingface/transformers";

const MODEL = "alephpi/FormulaNet";
const SIZE = 384;
const MEAN = 0.7931;
const STD = 0.1738;

export class MathFormulaRecognizer {
  constructor({ wasmPath, onProgress } = {}) {
    env.allowLocalModels = false;
    env.useBrowserCache = true;
    env.backends.onnx.wasm.proxy = false;
    if (wasmPath) env.backends.onnx.wasm.wasmPaths = wasmPath;
    this.onProgress = onProgress;
    this.ready = null;
  }

  async load() {
    if (!this.ready) this.ready = Promise.all([
      VisionEncoderDecoderModel.from_pretrained(MODEL, {
        dtype: "fp32",
        progress_callback: (progress) => this.onProgress?.(progress),
      }),
      PreTrainedTokenizer.from_pretrained(MODEL),
    ]).then(([model, tokenizer]) => ({ model, tokenizer }));
    return this.ready;
  }

  async recognize(canvas) {
    const { model, tokenizer } = await this.load();
    const values = preprocess(canvas);
    const channels = new Float32Array(SIZE * SIZE * 3);
    channels.set(values, 0);
    channels.set(values, SIZE * SIZE);
    channels.set(values, SIZE * SIZE * 2);
    const outputs = await model.generate({ inputs: new Tensor("float32", channels, [1, 3, SIZE, SIZE]) });
    return tokenizer.batch_decode(outputs, { skip_special_tokens: true })[0]?.trim() || "";
  }
}

function preprocess(source) {
  const sourceContext = source.getContext("2d", { willReadFrequently: true });
  const { data, width, height } = sourceContext.getImageData(0, 0, source.width, source.height);
  const grey = new Uint8Array(width * height);
  let dark = 0;
  for (let index = 0; index < grey.length; index++) {
    const offset = index * 4;
    grey[index] = Math.round(data[offset] * 0.299 + data[offset + 1] * 0.587 + data[offset + 2] * 0.114);
    if (grey[index] < 200) dark++;
  }
  const invert = dark >= grey.length - dark;
  let left = width, top = height, right = -1, bottom = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const value = invert ? 255 - grey[y * width + x] : grey[y * width + x];
    if (value < 200) { left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y); }
  }
  if (right < left) { left = 0; top = 0; right = width - 1; bottom = height - 1; }
  const cropWidth = Math.max(1, right - left + 1);
  const cropHeight = Math.max(1, bottom - top + 1);
  const scale = Math.min(SIZE / cropWidth, SIZE / cropHeight);
  const drawWidth = Math.max(1, Math.round(cropWidth * scale));
  const drawHeight = Math.max(1, Math.round(cropHeight * scale));
  const target = new OffscreenCanvas(SIZE, SIZE);
  const context = target.getContext("2d", { willReadFrequently: true });
  context.fillStyle = invert ? "black" : "white";
  context.fillRect(0, 0, SIZE, SIZE);
  context.drawImage(source, left, top, cropWidth, cropHeight, (SIZE - drawWidth) / 2, (SIZE - drawHeight) / 2, drawWidth, drawHeight);
  const resized = context.getImageData(0, 0, SIZE, SIZE).data;
  const normalized = new Float32Array(SIZE * SIZE);
  for (let index = 0; index < normalized.length; index++) {
    const offset = index * 4;
    let value = (resized[offset] * 0.299 + resized[offset + 1] * 0.587 + resized[offset + 2] * 0.114) / 255;
    if (invert) value = 1 - value;
    normalized[index] = (value - MEAN) / STD;
  }
  return normalized;
}
