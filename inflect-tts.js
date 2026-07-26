export class InflectTTS {
  static MODELS = {
    micro: "https://huggingface.co/owensong/Inflect-Micro-v2-ONNX/resolve/main/onnx/",
    nano: "https://huggingface.co/owensong/Inflect-Nano-v2-ONNX/resolve/main/onnx/",
  };

  constructor({ model = "micro", onStatus = () => {} } = {}) {
    this.model = model;
    this.onStatus = onStatus;
    this.pending = new Map();
    this.preloads = new Map();
    this.nextId = 1;
    this.worker = null;
    this.audioContext = null;
    this.source = null;
    this.playbackGeneration = 0;
  }

  get supported() { return "gpu" in navigator && typeof Worker !== "undefined"; }

  setModel(model) {
    if (!InflectTTS.MODELS[model]) throw new Error(`Unknown model: ${model}`);
    this.stop();
    this.model = model;
  }

  async init() {
    if (this.worker) return;
    if (!this.supported) throw new Error("This browser does not expose WebGPU.");
    this.worker = new Worker(chrome.runtime.getURL("dist/tts-worker.js"));
    this.worker.onmessage = ({ data }) => this.#message(data);
    this.worker.onerror = ({ message }) => this.#fail(new Error(message || "TTS worker failed."));
  }

  async preload(model = this.model) {
    if (this.preloads.has(model)) return this.preloads.get(model);
    const promise = (async () => {
      await this.init();
      return this.#request({ type: "preload", modelBase: InflectTTS.MODELS[model] });
    })().catch((error) => { this.preloads.delete(model); throw error; });
    this.preloads.set(model, promise);
    return promise;
  }

  async synthesize(text, { model = this.model, speed = 1, seed = 7 } = {}) {
    await this.preload(model);
    return this.#request({ type: "synthesize", text, modelBase: InflectTTS.MODELS[model], speed, seed });
  }

  async speak(text, options = {}) {
    if (!this.audioContext) this.audioContext = new AudioContext();
    await this.audioContext.resume();
    this.stop();
    const generation = this.playbackGeneration;
    const { samples, sampleRate } = await this.synthesize(text, options);
    if (generation !== this.playbackGeneration) return;
    const buffer = this.audioContext.createBuffer(1, samples.length, sampleRate);
    buffer.copyToChannel(samples, 0);
    return new Promise((resolve) => {
      const source = this.audioContext.createBufferSource();
      source.buffer = buffer;
      source.connect(this.audioContext.destination);
      source.onended = () => { if (this.source === source) this.source = null; resolve(); };
      this.source = source;
      source.start();
    });
  }

  stop() {
    this.playbackGeneration++;
    if (!this.source) return;
    try { this.source.stop(); } catch { /* already stopped */ }
    this.source = null;
  }

  async clearCache() {
    this.stop();
    this.worker?.terminate();
    this.worker = null;
    const error = new Error("Inflect cache cleared.");
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
    this.preloads.clear();
    await caches.delete("inflect-onnx-models-v1");
  }

  #request(message) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...message, id });
    });
  }

  #message(data) {
    if (data.type === "progress") {
      const phase = data.phase === "compiling"
        ? "Compiling WebGPU"
        : data.phase === "loading" ? "Loading cached voice" : "Downloading voice";
      this.onStatus({ state: "loading", message: `${phase} · ${Math.round(data.fraction * 100)}%` });
      return;
    }
    const request = this.pending.get(data.id);
    if (!request) return;
    this.pending.delete(data.id);
    if (data.type === "error") request.reject(new Error(data.message));
    else request.resolve(data);
  }

  #fail(error) {
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
    this.onStatus({ state: "error", message: error.message });
  }
}
