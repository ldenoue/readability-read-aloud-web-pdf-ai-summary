let worker;
let sequence = 0;
const requests = new Map();

function getWorker() {
  if (worker) return worker;
  const runtime = globalThis.chrome?.runtime || globalThis.browser?.runtime;
  const workerUrl = runtime?.getURL("dist/summary-worker.js") || new URL("summary-worker.js", import.meta.url).href;
  worker = new Worker(workerUrl, { type: "module" });
  worker.onmessage = ({ data }) => {
    const request = requests.get(data.id);
    if (!request) return;
    if (data.type === "progress") request.onProgress?.(data.progress);
    else {
      requests.delete(data.id);
      if (data.type === "result") request.resolve(data.text);
      else request.reject(new Error(data.message || "Gemma 3 summarization failed."));
    }
  };
  worker.onerror = ({ message }) => {
    const error = new Error(message || "Gemma 3 summarization worker failed.");
    for (const request of requests.values()) request.reject(error);
    requests.clear();
    worker.terminate();
    worker = null;
  };
  return worker;
}

function requestGemma(type, payload, onProgress) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    requests.set(id, { resolve, reject, onProgress });
    getWorker().postMessage({ type, id, ...payload });
  });
}

export function summarizeWithGemma(text, mode, onProgress) {
  return requestGemma("summarize", { text, mode }, onProgress);
}

export function measureGemmaTokens(text, onProgress) {
  return requestGemma("measure", { text }, onProgress);
}

export function clearGemmaSummarizer() {
  if (!worker) return;
  const error = new Error("Gemma 3 summarizer was cleared.");
  for (const request of requests.values()) request.reject(error);
  requests.clear();
  worker.terminate();
  worker = null;
}
