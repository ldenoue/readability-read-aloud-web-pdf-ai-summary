import { env, pipeline } from "@huggingface/transformers";

const MODEL = "Xenova/all-MiniLM-L6-v2";
env.allowLocalModels = false;
env.useBrowserCache = true;
env.backends.onnx.wasm.proxy = false;
env.backends.onnx.wasm.numThreads = 1;
env.backends.onnx.wasm.wasmPaths = new URL("./math-runtime/", import.meta.url).href;

let extractorPromise;

async function extractor(onProgress) {
  extractorPromise ||= pipeline("feature-extraction", MODEL, {
    dtype: "q8",
    device: "wasm",
    progress_callback: onProgress,
  });
  return extractorPromise;
}

self.onmessage = async ({ data }) => {
  if (data.type !== "embed") return;
  try {
    const model = await extractor((progress) => self.postMessage({ type: "progress", id: data.id, progress }));
    const texts = (data.texts || []).map((text) => String(text || "").trim()).filter(Boolean);
    if (!texts.length) throw new Error("No text to embed.");
    const output = await model(texts, { pooling: "mean", normalize: true });
    self.postMessage({ type: "result", id: data.id, vectors: output.tolist() });
  } catch (error) {
    self.postMessage({ type: "error", id: data.id, message: error instanceof Error ? error.message : String(error) });
  }
};
