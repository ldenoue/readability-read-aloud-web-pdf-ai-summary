import init, { Model } from './pocket-tts/ptts_wasm.js';

const HF_BASE = 'https://huggingface.co/kyutai/pocket-tts-without-voice-cloning/resolve/main';
const HF_BASE_Q8 = 'https://huggingface.co/lmz/pocket-tts-without-voice-cloning-q8/resolve/main';
const TOKENIZER_URL = `${HF_BASE}/tokenizer.model`;
const ASSET_CACHE = 'pocket-tts-assets-v1';
const WASM_URL = './pocket-tts/ptts_wasm_bg.wasm?v=pocket-tts-20260520';
const VOICE_NAMES = ['alba', 'jean', 'marius', 'javert', 'fantine', 'cosette', 'eponine', 'azelma'];

let model = null;
let tokenizer = null;
let sampleRate = 24000;
let loadedQuant = '';
let wasmReady = false;
let loadPromise = null;
const voiceIndexMap = {};
const canceledRequests = new Set();

function post(status, extra = {}) {
  self.postMessage({ status, ...extra });
}

function modelUrl(quant) {
  if (quant === 'q8') return `${HF_BASE_Q8}/tts_b6369a24.gguf`;
  return `${HF_BASE}/tts_b6369a24.safetensors`;
}

function voiceUrl(name) {
  return `${HF_BASE}/embeddings_v3/${name}.safetensors`;
}

function cacheRequest(url) {
  // A relative synthetic Request is not reliably resolvable inside an
  // extension module Worker. The stable Hugging Face resolve URL is already a
  // valid absolute cache key (redirect signatures are intentionally excluded).
  return new Request(url, { method: 'GET', mode: 'cors' });
}

function isCanceled(requestId) {
  return requestId != null && canceledRequests.has(requestId);
}

function throwIfCanceled(requestId) {
  if (isCanceled(requestId)) throw new DOMException('Canceled', 'AbortError');
}

function yieldToMessages() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

async function fetchWithProgress(url, label) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to fetch ${label}: HTTP ${resp.status}`);
  const contentType = resp.headers.get('content-type') || 'application/octet-stream';
  const total = parseInt(resp.headers.get('content-length') || '0', 10);
  const reader = resp.body.getReader();
  const chunks = [];
  let received = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    const mb = (received / 1e6).toFixed(1);
    const detail = total > 0 ? `${mb} / ${(total / 1e6).toFixed(1)} MB` : `${mb} MB`;
    post('progress', { message: `Loading ${label} (${detail})...` });
  }

  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return { bytes, contentType };
}

async function fetchCachedBytes(url, label) {
  if (!('caches' in self)) {
    const { bytes } = await fetchWithProgress(url, label);
    return bytes;
  }

  let cache = null;
  let request = null;
  try {
    cache = await caches.open(ASSET_CACHE);
    request = cacheRequest(url);
    const cached = await cache.match(request);
    if (cached) {
      post('progress', { message: `Loading ${label} from browser cache...` });
      return new Uint8Array(await cached.arrayBuffer());
    }
  } catch (err) {
    console.warn(`[pocket-tts-worker] could not read cache for ${label}`, err);
  }

  const { bytes, contentType } = await fetchWithProgress(url, label);
  if (cache && request) {
    try {
      await cache.put(request, new Response(bytes.slice(), {
        headers: {
          'content-length': String(bytes.byteLength),
          'content-type': contentType,
        },
      }));
      const stored = await cache.match(request);
      if (!stored) throw new Error('cache verification failed');
      post('progress', { message: `Saved ${label} in persistent browser cache.` });
    } catch (err) {
      console.warn(`[pocket-tts-worker] could not cache ${label}`, err);
      post('progress', { message: `Could not save ${label}; it may download again next time.` });
    }
  }
  return bytes;
}

async function initWasm() {
  if (wasmReady) return;
  post('progress', { message: 'Loading engine...' });
  const resp = await fetch(WASM_URL, { cache: 'no-cache' });
  if (!resp.ok) throw new Error(`Failed to load PocketTTS WASM: HTTP ${resp.status}`);
  const module = await WebAssembly.compile(await resp.arrayBuffer());
  await init({ module_or_path: module });
  wasmReady = true;
}

function decodeSentencepieceModel(buffer) {
  let pos = 0;

  function readVarint() {
    let result = 0, shift = 0;
    while (pos < buffer.length) {
      const b = buffer[pos++];
      result |= (b & 0x7f) << shift;
      shift += 7;
      if ((b & 0x80) === 0) return result;
    }
    return result;
  }

  function readBytes(n) {
    const data = buffer.slice(pos, pos + n);
    pos += n;
    return data;
  }

  function readVarIntFrom(buf, p) {
    let result = 0, shift = 0;
    while (p < buf.length) {
      const b = buf[p++];
      result |= (b & 0x7f) << shift;
      shift += 7;
      if ((b & 0x80) === 0) return { val: result, pos: p };
    }
    return { val: result, pos: p };
  }

  function decodePiece(data) {
    let pPos = 0, piece = '', score = 0, type = 1;
    const pView = new DataView(data.buffer, data.byteOffset, data.byteLength);
    while (pPos < data.length) {
      const key = readVarIntFrom(data, pPos);
      pPos = key.pos;
      const fieldNum = key.val >>> 3;
      const wireType = key.val & 0x7;
      if (fieldNum === 1 && wireType === 2) {
        const len = readVarIntFrom(data, pPos);
        pPos = len.pos;
        piece = new TextDecoder().decode(data.slice(pPos, pPos + len.val));
        pPos += len.val;
      } else if (fieldNum === 2 && wireType === 5) {
        score = pView.getFloat32(pPos, true);
        pPos += 4;
      } else if (fieldNum === 3 && wireType === 0) {
        const v = readVarIntFrom(data, pPos);
        type = v.val;
        pPos = v.pos;
      } else if (wireType === 0) {
        const v = readVarIntFrom(data, pPos);
        pPos = v.pos;
      } else if (wireType === 1) {
        pPos += 8;
      } else if (wireType === 2) {
        const len = readVarIntFrom(data, pPos);
        pPos = len.pos + len.val;
      } else if (wireType === 5) {
        pPos += 4;
      } else {
        break;
      }
    }
    return { piece, score, type };
  }

  const pieces = [];
  while (pos < buffer.length) {
    const key = readVarint();
    const fieldNum = key >>> 3;
    const wireType = key & 0x7;
    if (fieldNum === 1 && wireType === 2) {
      pieces.push(decodePiece(readBytes(readVarint())));
    } else if (wireType === 0) {
      readVarint();
    } else if (wireType === 1) {
      pos += 8;
    } else if (wireType === 2) {
      pos += readVarint();
    } else if (wireType === 5) {
      pos += 4;
    } else {
      break;
    }
  }
  return pieces;
}

class UnigramTokenizer {
  constructor(pieces) {
    this.vocab = new Map();
    this.unkId = 0;
    for (let i = 0; i < pieces.length; i++) {
      const p = pieces[i];
      if (p.type === 2) this.unkId = i;
      if (p.type === 1 || p.type === 4 || p.type === 6) {
        this.vocab.set(p.piece, { id: i, score: p.score });
      }
    }
  }

  encode(text) {
    return this.viterbi('\u2581' + text.replace(/ /g, '\u2581'));
  }

  viterbi(text) {
    const n = text.length;
    const best = Array.from({ length: n + 1 }, () => ({ score: -Infinity, len: 0, id: -1 }));
    best[0] = { score: 0, len: 0, id: -1 };

    for (let i = 0; i < n; i++) {
      if (best[i].score === -Infinity) continue;
      for (let len = 1; len <= n - i && len <= 64; len++) {
        const entry = this.vocab.get(text.substring(i, i + len));
        if (!entry) continue;
        const score = best[i].score + entry.score;
        if (score > best[i + len].score) best[i + len] = { score, len, id: entry.id };
      }
      if (best[i + 1].score === -Infinity) {
        const ch = text.charCodeAt(i);
        const byteStr = `<0x${ch.toString(16).toUpperCase().padStart(2, '0')}>`;
        const entry = this.vocab.get(byteStr);
        best[i + 1] = {
          score: best[i].score + (entry ? entry.score : -100),
          len: 1,
          id: entry ? entry.id : this.unkId,
        };
      }
    }

    const ids = [];
    let p = n;
    while (p > 0) {
      ids.push(best[p].id);
      p -= best[p].len;
    }
    ids.reverse();
    return new Uint32Array(ids);
  }
}

async function ensureModel(quant = 'q8') {
  if (model && tokenizer && loadedQuant === quant) return;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    if (model && loadedQuant !== quant && typeof model.free === 'function') model.free();
    model = null;
    tokenizer = null;
    loadedQuant = '';
    for (const key of Object.keys(voiceIndexMap)) delete voiceIndexMap[key];

    await initWasm();

    post('progress', { message: 'Loading tokenizer...' });
    const tokData = await fetchCachedBytes(TOKENIZER_URL, 'tokenizer');
    tokenizer = new UnigramTokenizer(decodeSentencepieceModel(tokData));

    post('progress', { message: 'Loading model...' });
    const modelWeights = await fetchCachedBytes(modelUrl(quant), 'model');
    model = new Model(modelWeights, quant);
    sampleRate = model.sample_rate();
    loadedQuant = quant;
  })();

  try {
    await loadPromise;
  } finally {
    loadPromise = null;
  }
}

async function ensureVoice(name) {
  const voice = VOICE_NAMES.includes(name) ? name : 'alba';
  if (voiceIndexMap[voice] != null) return voiceIndexMap[voice];
  post('progress', { message: `Loading voice ${voice}...` });
  const voiceData = await fetchCachedBytes(voiceUrl(voice), `voice ${voice}`);
  voiceIndexMap[voice] = model.add_voice(voiceData);
  return voiceIndexMap[voice];
}

function concatenateChunks(chunks) {
  const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
  const result = new Float32Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function writeWavFile(samples, rate) {
  const numChannels = 1;
  const bitsPerSample = 16;
  const blockAlign = numChannels * bitsPerSample / 8;
  const dataSize = samples.length * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  function writeString(offset, str) {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  }

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    let s = Math.max(-1, Math.min(1, samples[i]));
    s = s < 0 ? s * 0x8000 : s * 0x7fff;
    view.setInt16(offset, s, true);
    offset += 2;
  }
  return buffer;
}

async function speak(data) {
  const text = data.text?.trim();
  if (!text) throw new Error('No text provided');

  const requestId = data.requestId;
  const quant = data.quant || 'q8';
  const voice = data.voice || 'alba';
  const temperature = Number(data.temperature ?? 0.7);
  const shouldStream = data.stream !== false && data.reason === 'play';

  throwIfCanceled(requestId);
  await ensureModel(quant);
  throwIfCanceled(requestId);
  const voiceIndex = await ensureVoice(voice);
  throwIfCanceled(requestId);

  const [processedText, framesAfterEos] = model.prepare_text(text);
  const tokenIds = tokenizer.encode(processedText);
  model.start_generation(voiceIndex, tokenIds, framesAfterEos, temperature);
  if (shouldStream) {
    post('stream-start', { id: data.id, requestId, reason: data.reason, sampleRate });
  }

  const chunks = [];
  let step = 0;
  while (true) {
    throwIfCanceled(requestId);
    const chunk = model.generation_step();
    if (!chunk) break;
    const chunkCopy = new Float32Array(chunk);
    if (!shouldStream) chunks.push(chunkCopy);
    if (shouldStream) {
      const streamChunk = new Float32Array(chunkCopy);
      self.postMessage({
        status: 'stream-chunk',
        id: data.id,
        requestId,
        reason: data.reason,
        pcm: streamChunk,
        sampleRate,
      }, [streamChunk.buffer]);
    }
    step++;
    if (step % 4 === 0) post('progress', { message: `Generating audio (${step} chunks)...` });
    if (step % 2 === 0) await yieldToMessages();
  }
  if (shouldStream) {
    post('stream-complete', { id: data.id, requestId, reason: data.reason });
  }

  if (shouldStream) return null;
  const wav = writeWavFile(concatenateChunks(chunks), sampleRate);
  return new Blob([wav], { type: 'audio/wav' });
}

async function clearCache() {
  if (typeof model?.free === 'function') model.free();
  model = null;
  tokenizer = null;
  loadedQuant = '';
  for (const key of Object.keys(voiceIndexMap)) delete voiceIndexMap[key];
  if ('caches' in self) await caches.delete(ASSET_CACHE);
}

self.addEventListener('message', async (event) => {
  const data = event.data || {};

  if (data.command === 'cancel') {
    if (data.requestId != null) canceledRequests.add(data.requestId);
    return;
  }

  if (data.command === 'clear-cache') {
    try {
      await clearCache();
      post('ready');
    } catch (err) {
      post('error', { error: err?.message || String(err), id: data.id });
    }
    return;
  }

  if (data.command === 'load') {
    try {
      await ensureModel(data.quant || 'q8');
      await ensureVoice(data.voice || 'alba');
      post('loaded', { backend: 'pocket-tts' });
    } catch (err) {
      post('error', { error: err?.message || String(err), id: data.id });
    }
    return;
  }

  if (data.command !== 'tts') return;

  try {
    const audio = await speak(data);
    post('complete', { text: data.text, id: data.id, requestId: data.requestId, reason: data.reason, audio });
  } catch (err) {
    const canceled = err?.name === 'AbortError' || isCanceled(data.requestId);
    post(canceled ? 'canceled' : 'error', {
      error: canceled ? 'Canceled' : err?.message || String(err),
      id: data.id,
      requestId: data.requestId,
      reason: data.reason,
    });
  } finally {
    if (data.requestId != null) canceledRequests.delete(data.requestId);
  }
});

post('ready');
