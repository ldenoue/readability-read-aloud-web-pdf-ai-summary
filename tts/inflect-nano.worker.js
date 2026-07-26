import * as ort from "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.27.0/dist/ort.webgpu.min.mjs";
import { phonemize } from "https://cdn.jsdelivr.net/npm/phonemizer@1.2.1/+esm";

// Manifest V3 builds bundle the runtime and copy its WebAssembly core locally.
// Bundled extension workers do not expose an ESM `import.meta.url` to ORT.
// Supplying the exact WASM binary keeps ORT on its embedded JS module path,
// so it never has to infer a script URL or dynamically import another file.
if (self.location?.protocol === "chrome-extension:") {
  ort.env.wasm.wasmPaths = {
    wasm: new URL("./ort-wasm-simd-threaded.asyncify.wasm", self.location.href).href,
  };
}
ort.env.wasm.numThreads = 1;

const DEFAULT_MODEL_BASE = "https://huggingface.co/owensong/Inflect-Nano-v2-ONNX/resolve/main/onnx/";
const SAMPLE_RATE = 24000;
const SYMBOLS = [
  "_",
  ...';:,.!?¡¿—…"«»“” ',
  ..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz",
  ..."ɑɐɒæɓʙβɔɕçɗɖðʤəɘɚɛɜɝɞɟʄɡɠɢʛɦɧħɥʜɨɪʝɭɬɫɮʟɱɯɰŋɳɲɴøɵɸθœɶʘɹɺɾɻʀʁɽʂʃʈʧʉʊʋⱱʌɣɤʍχʎʏʑʐʒʔʡʕʢǀǁǂǃˈˌːˑʼʴʰʱʲʷˠˤ˞↓↑→↗↘'̩'ᵻ",
];
const SYMBOL_TO_ID = new Map(SYMBOLS.map((symbol, index) => [symbol, index]));
const PHONEME_OVERRIDES = new Map([["sˈæskɐtʃˌuːən", "sɐskˈætʃəwən"], ["flʊɹɹˈɛsənt", "flʊˈɹɛsənt"]]);
const SPLIT_PUNCTUATION = new Set([",", ";", ":", ".", "!", "?"]);
const sessionCache = new Map();
let queue = Promise.resolve();

function normalizeText(text) {
  return String(text)
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, ", ")
    .replace(/[…]/g, "...")
    .replace(/[()[\]{}]/g, ", ")
    .replace(/\s+/g, " ")
    .trim();
}

function seededGaussian(seed) {
  let state = (Number(seed) || 0) >>> 0;
  const random = () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
  let spare = null;
  return () => {
    if (spare !== null) { const value = spare; spare = null; return value; }
    let x; let y; let radius;
    do { x = random() * 2 - 1; y = random() * 2 - 1; radius = x * x + y * y; } while (radius >= 1 || radius === 0);
    const scale = Math.sqrt((-2 * Math.log(radius)) / radius);
    spare = y * scale;
    return x * scale;
  };
}

async function fetchModel(url, onProgress) {
  const cacheName = "inflect-onnx-models-v1";
  let response;
  let cache;
  let phase = "downloading";
  try {
    cache = await caches.open(cacheName);
    response = await cache.match(url.href);
  } catch { /* Cache Storage may be unavailable or disabled. */ }
  if (response) phase = "loading";
  else {
    response = await fetch(url);
    if (response.ok && cache) {
      try { await cache.put(url.href, response.clone()); } catch { /* Quota errors should not block speech. */ }
    }
  }
  if (!response.ok || !response.body) throw new Error(`Model download failed (${response.status}).`);
  const total = Number(response.headers.get("content-length")) || 0;
  const reader = response.body.getReader();
  const chunks = [];
  let loaded = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress(loaded, total || loaded, phase);
  }
  const bytes = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

async function sessions(modelBase, onProgress) {
  if (sessionCache.has(modelBase)) return sessionCache.get(modelBase);
  const promise = (async () => {
    const progress = { duration: 0, decode: 0 };
    const totals = { duration: 1, decode: 1 };
    const phases = { duration: "loading", decode: "loading" };
    const report = () => onProgress(
      (progress.duration + progress.decode) / (totals.duration + totals.decode),
      Object.values(phases).includes("downloading") ? "downloading" : "loading",
    );
    const load = (name) => fetchModel(new URL(`${name}.onnx`, modelBase), (loaded, total, phase) => {
      progress[name] = loaded;
      totals[name] = total;
      phases[name] = phase;
      report();
    });
    const [durationBytes, decodeBytes] = await Promise.all([load("duration"), load("decode")]);
    onProgress(1, "compiling");
    const options = { executionProviders: ["webgpu"] };
    // ORT WebGPU owns a single EP initialization lane. Creating both graphs
    // concurrently can fail with "another WebGPU EP inference session...".
    const duration = await ort.InferenceSession.create(durationBytes, options);
    const decode = await ort.InferenceSession.create(decodeBytes, options);
    return { duration, decode, backend: "WebGPU" };
  })();
  sessionCache.set(modelBase, promise);
  return promise;
}

function tokenIds(phonemeText) {
  const ids = [];
  for (const symbol of phonemeText) {
    const id = SYMBOL_TO_ID.get(symbol);
    if (id !== undefined) ids.push(id);
  }
  if (!ids.length) throw new Error("The phonemizer produced no supported symbols.");
  const withBlanks = new Array(ids.length * 2 + 1).fill(0);
  for (let index = 0; index < ids.length; index++) withBlanks[index * 2 + 1] = ids[index];
  return withBlanks.map(BigInt);
}

function finishWaveform(input) {
  const output = new Float32Array(input);
  const fade = Math.min(Math.round(SAMPLE_RATE * 0.005), Math.floor(output.length / 2));
  for (let index = 0; index < fade; index++) {
    const ramp = fade > 1 ? index / (fade - 1) : 1;
    output[index] *= ramp;
    output[output.length - 1 - index] *= ramp;
  }
  return output;
}

function splitPreservingPunctuation(text) {
  const pieces = [];
  let current = "";
  for (const character of text) {
    current += character;
    if (SPLIT_PUNCTUATION.has(character)) { pieces.push(current.trim()); current = ""; }
  }
  if (current.trim()) pieces.push(current.trim());
  return pieces;
}

async function buildPhonemeText(text) {
  const parts = [];
  for (const piece of splitPreservingPunctuation(text)) {
    const finalCharacter = piece.slice(-1);
    const punctuation = SPLIT_PUNCTUATION.has(finalCharacter) ? finalCharacter : "";
    const words = punctuation ? piece.slice(0, -1).trim() : piece;
    if (!words) { if (punctuation) parts.push(punctuation); continue; }
    const result = await phonemize(words, "en-us");
    let phonemes = (Array.isArray(result) ? result.join(" ") : String(result)).replace(/\s+/g, " ").trim();
    for (const [source, replacement] of PHONEME_OVERRIDES) phonemes = phonemes.replaceAll(source, replacement);
    parts.push(phonemes + punctuation);
  }
  return parts.join(" ");
}

async function synthesize({ text, seed = 7, speed = 1, variation = 0.667, modelBase = DEFAULT_MODEL_BASE, id }) {
  const normalizedText = normalizeText(text);
  const phonemeText = await buildPhonemeText(normalizedText);
  const ids = tokenIds(phonemeText);
  const report = (fraction, phase) => self.postMessage({ type: "progress", id, fraction, phase });
  const { duration, decode, backend } = await sessions(modelBase, report);
  const tokens = new ort.Tensor("int64", BigInt64Array.from(ids), [1, ids.length]);
  const lengths = new ort.Tensor("int64", BigInt64Array.from([BigInt(ids.length)]), [1]);
  const lengthScale = new ort.Tensor("float32", Float32Array.from([1 / Math.max(0.5, Math.min(2, speed))]), []);
  const durationOutput = await duration.run({ tokens, lengths, length_scale: lengthScale });
  const { m_p_exp: means, logs_p_exp: logScales, y_mask: mask } = durationOutput;
  if (!means || !logScales || !mask) throw new Error("Unexpected duration model outputs.");
  const count = means.dims.reduce((product, value) => product * value, 1);
  const gaussian = seededGaussian(seed);
  const noise = new Float32Array(count);
  for (let index = 0; index < count; index++) noise[index] = gaussian();
  const latentNoise = new ort.Tensor("float32", noise, means.dims);
  const noiseScale = new ort.Tensor("float32", Float32Array.from([Math.max(0, Math.min(1, variation))]), []);
  const decoded = await decode.run({ m_p_exp: means, logs_p_exp: logScales, y_mask: mask, zp_noise: latentNoise, noise_scale: noiseScale });
  if (!(decoded.waveform?.data instanceof Float32Array)) throw new Error("Unexpected decoder output.");
  return { samples: finishWaveform(decoded.waveform.data), sampleRate: SAMPLE_RATE, normalizedText, phonemeText, backend };
}

async function handle(message) {
  try {
    if (message.type === "preload") {
      const result = await sessions(message.modelBase || DEFAULT_MODEL_BASE, (fraction, phase) => self.postMessage({ type: "progress", id: message.id, fraction, phase }));
      self.postMessage({ type: "preloaded", id: message.id, backend: result.backend });
      return;
    }
    const started = performance.now();
    const result = await synthesize(message);
    self.postMessage({ type: "result", id: message.id, ...result, synthMs: performance.now() - started }, [result.samples.buffer]);
  } catch (error) {
    self.postMessage({ type: "error", id: message.id, message: error instanceof Error ? error.message : String(error) });
  }
}

self.onmessage = ({ data }) => { queue = queue.then(() => handle(data)); };
