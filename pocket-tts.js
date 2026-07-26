export class PocketTTS {
  static VOICES = ["alba", "jean", "marius", "javert", "fantine", "cosette", "eponine", "azelma"];

  constructor({ voice = "azelma", onStatus = () => {} } = {}) {
    this.voice = voice;
    this.onStatus = onStatus;
    this.worker = null;
    this.audioContext = null;
    this.source = null;
    this.pending = new Map();
    this.nextId = 1;
    this.activeRequestId = null;
    this.playbackGeneration = 0;
  }

  setVoice(voice) {
    if (!PocketTTS.VOICES.includes(voice)) throw new Error(`Unknown PocketTTS voice: ${voice}`);
    this.stop();
    this.voice = voice;
  }

  async init() {
    if (this.worker) return;
    this.worker = new Worker(chrome.runtime.getURL("pocket-tts-worker.js"), { type: "module" });
    this.worker.onmessage = ({ data }) => this.#message(data);
    this.worker.onerror = ({ message }) => this.#fail(new Error(message || "PocketTTS worker failed."));
  }

  async synthesize(text, { voice = this.voice } = {}) {
    await this.init();
    const id = this.nextId++;
    this.activeRequestId = id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, {
        resolve,
        reject,
        sources: new Set(),
        nextStart: 0,
        streamComplete: false,
      });
      this.worker.postMessage({
        command: "tts",
        text,
        voice,
        quant: "q8",
        id,
        requestId: id,
        reason: "play",
        stream: true,
      });
    });
  }

  async speak(text, { voice = this.voice } = {}) {
    if (!this.audioContext) this.audioContext = new AudioContext();
    await this.audioContext.resume();
    this.stop();
    const generation = this.playbackGeneration;
    await this.synthesize(text, { voice });
    if (generation !== this.playbackGeneration) return;
  }

  stop() {
    this.playbackGeneration++;
    if (this.activeRequestId != null && this.worker) {
      this.worker.postMessage({ command: "cancel", requestId: this.activeRequestId });
    }
    const request = this.pending.get(this.activeRequestId);
    for (const source of request?.sources || []) {
      try { source.stop(); } catch { /* already stopped */ }
    }
    if (this.source) try { this.source.stop(); } catch { /* already stopped */ }
    this.source = null;
  }

  async clearCache() {
    this.stop();
    this.worker?.terminate();
    this.worker = null;
    this.activeRequestId = null;
    const error = new Error("PocketTTS cache cleared.");
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
    await caches.delete("pocket-tts-assets-v1");
  }

  #message(data) {
    if (data.status === "progress") {
      this.onStatus({ state: "loading", message: data.message || "Preparing PocketTTS…" });
      return;
    }
    if (data.status === "stream-chunk") {
      const request = this.pending.get(data.requestId);
      if (request) this.#schedule(request, data.pcm, data.sampleRate);
      return;
    }
    if (data.status === "stream-complete") {
      const request = this.pending.get(data.requestId);
      if (request) {
        request.streamComplete = true;
        this.#finishIfDrained(data.requestId, request);
      }
      return;
    }
    if (!["complete", "error", "canceled"].includes(data.status)) return;
    const request = this.pending.get(data.requestId);
    if (!request) return;
    if (data.status === "complete") {
      request.streamComplete = true;
      this.#finishIfDrained(data.requestId, request);
    } else {
      this.pending.delete(data.requestId);
      if (this.activeRequestId === data.requestId) this.activeRequestId = null;
      request.reject(new Error(data.status === "canceled" ? "Canceled" : data.error || "PocketTTS failed."));
    }
  }

  #schedule(request, pcm, sampleRate) {
    if (!(pcm instanceof Float32Array) || !pcm.length) return;
    const buffer = this.audioContext.createBuffer(1, pcm.length, sampleRate || 24000);
    buffer.copyToChannel(pcm, 0);
    const source = this.audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(this.audioContext.destination);
    const start = Math.max(this.audioContext.currentTime + 0.025, request.nextStart);
    request.nextStart = start + buffer.duration;
    request.sources.add(source);
    this.source = source;
    source.onended = () => {
      request.sources.delete(source);
      if (this.source === source) this.source = null;
      const id = [...this.pending].find(([, value]) => value === request)?.[0];
      if (id != null) this.#finishIfDrained(id, request);
    };
    source.start(start);
  }

  #finishIfDrained(id, request) {
    if (!request.streamComplete || request.sources.size) return;
    this.pending.delete(id);
    if (this.activeRequestId === id) this.activeRequestId = null;
    request.resolve();
  }

  #fail(error) {
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
    this.onStatus({ state: "error", message: error.message });
  }
}
