let worker;
let sequence = 0;
const requests = new Map();

function getWorker() {
  if (worker) return worker;
  const runtime = globalThis.chrome?.runtime || globalThis.browser?.runtime;
  const workerUrl = runtime?.getURL("dist/embedding-worker.js") || new URL("embedding-worker.js", import.meta.url).href;
  worker = new Worker(workerUrl, { type: "module" });
  worker.onmessage = ({ data }) => {
    const request = requests.get(data.id);
    if (!request) return;
    if (data.type === "progress") request.onProgress?.(data.progress);
    else {
      requests.delete(data.id);
      if (data.type === "result") request.resolve(data.vectors);
      else request.reject(new Error(data.message || "Embedding failed."));
    }
  };
  worker.onerror = ({ message }) => {
    const error = new Error(message || "Embedding worker failed.");
    for (const request of requests.values()) request.reject(error);
    requests.clear();
    worker.terminate();
    worker = null;
  };
  return worker;
}

export function embedTexts(texts, onProgress) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    requests.set(id, { resolve, reject, onProgress });
    getWorker().postMessage({ type: "embed", id, texts });
  });
}

export function cosineSimilarity(left, right) {
  if (!left?.length || left.length !== right?.length) return 0;
  let score = 0;
  for (let index = 0; index < left.length; index++) score += left[index] * right[index];
  return score;
}
