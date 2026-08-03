const jobs = new Map();

function publish(job, event) {
  if (event.type === "page") job.pages.set(event.page.page, event);
  if (event.type === "result" || event.type === "error") job.final = event;
  job.channel.postMessage(event);
}

function publishSnapshot(job) {
  for (const event of [...job.pages.values()].sort((left, right) => left.page.page - right.page.page)) job.channel.postMessage(event);
  if (job.final) job.channel.postMessage(job.final);
}

async function downloadPdf(job, url) {
  publish(job, { type: "opening", message: "Downloading PDF…" });
  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) throw new Error(`Could not download PDF (${response.status}).`);
  if ((response.headers.get("content-type") || "").includes("text/html")) throw new Error("The PDF URL returned an HTML page, possibly a sign-in screen.");
  const total = Number(response.headers.get("content-length")) || 0;
  const chunks = [];
  let loaded = 0;
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    chunks.push(bytes);
    loaded = bytes.byteLength;
  } else {
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.byteLength;
      publish(job, { type: "download-progress", loaded, total });
    }
  }
  const bytes = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes.buffer;
}

async function startJob(jobId, url) {
  if (jobs.has(jobId)) return;
  const job = { channel: new BroadcastChannel(`pdf-processing-${jobId}`), pages: new Map(), final: null, worker: null };
  jobs.set(jobId, job);
  try {
    const bytes = await downloadPdf(job, url);
    publish(job, { type: "opening", message: `Opening ${(bytes.byteLength / 1e6).toFixed(1)} MB PDF…` });
    const worker = new Worker(chrome.runtime.getURL("pdfjs-pdf-worker.js"), { type: "module" });
    job.worker = worker;
    worker.onmessage = ({ data }) => {
      publish(job, data);
      if (["result", "error"].includes(data.type)) worker.terminate();
      else if (data.type === "ready") worker.postMessage({ type: "extract", bytes }, [bytes]);
    };
    worker.onerror = ({ message }) => publish(job, { type: "error", message: message || "PDF processing failed." });
  } catch (error) {
    publish(job, { type: "error", message: error instanceof Error ? error.message : String(error) });
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== "pdf-offscreen") return false;
  if (message.type === "pdf-start") void startJob(message.jobId, message.url);
  if (message.type === "pdf-snapshot") {
    const job = jobs.get(message.jobId);
    if (job) publishSnapshot(job);
  }
  sendResponse({ accepted: true });
  return false;
});
