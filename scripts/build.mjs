import { build } from "esbuild";
import { readFile, mkdir, copyFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import sharp from "sharp";

const extensionDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sharedWorker = path.resolve(extensionDir, "tts", "inflect-nano.worker.js");
await mkdir(path.join(extensionDir, "fonts"), { recursive: true });
await mkdir(path.join(extensionDir, "pdfjs"), { recursive: true });
await Promise.all(["pdf.mjs", "pdf.worker.mjs"].map((file) => copyFile(
  path.join(extensionDir, "node_modules", "pdfjs-dist", "build", file),
  path.join(extensionDir, "pdfjs", file),
)));
await Promise.all([400, 600, 700].map((weight) => copyFile(
  path.join(extensionDir, "node_modules", "@fontsource", "inter", "files", `inter-latin-${weight}-normal.woff2`),
  path.join(extensionDir, "fonts", `inter-${weight}.woff2`),
)));
const iconSvg = await readFile(path.join(extensionDir, "icons", "icon.svg"));
await Promise.all([16, 32, 48, 128].map((size) =>
  sharp(iconSvg).resize(size, size).png().toFile(path.join(extensionDir, "icons", `icon-${size}.png`)),
));
let source = await readFile(sharedWorker, "utf8");
source = source
  .replace('"https://cdn.jsdelivr.net/npm/onnxruntime-web@1.27.0/dist/ort.webgpu.min.mjs"', '"onnxruntime-web/webgpu"')
  .replace('"https://cdn.jsdelivr.net/npm/phonemizer@1.2.1/+esm"', '"phonemizer"');

await mkdir(path.join(extensionDir, "dist"), { recursive: true });
await mkdir(path.join(extensionDir, "dist", "math-runtime"), { recursive: true });
await copyFile(
  path.join(extensionDir, "node_modules", "marked", "lib", "marked.esm.js"),
  path.join(extensionDir, "dist", "marked.esm.js"),
);
await build({
  stdin: { contents: source, loader: "js", resolveDir: extensionDir },
  bundle: true,
  minify: true,
  format: "iife",
  platform: "browser",
  target: ["chrome120"],
  outfile: path.join(extensionDir, "dist", "tts-worker.js"),
  legalComments: "eof",
});

await build({
  entryPoints: [path.join(extensionDir, "readability-entry.js")],
  bundle: true,
  minify: true,
  format: "iife",
  platform: "browser",
  target: ["chrome120"],
  outfile: path.join(extensionDir, "dist", "readability.js"),
  legalComments: "eof",
});

await build({
  entryPoints: [path.join(extensionDir, "yolo-layout.js")],
  bundle: true,
  minify: true,
  format: "esm",
  platform: "browser",
  target: ["chrome120"],
  outfile: path.join(extensionDir, "dist", "yolo-layout.js"),
  legalComments: "eof",
});

await build({
  entryPoints: [path.join(extensionDir, "math-ocr.js")],
  bundle: true,
  minify: true,
  format: "esm",
  platform: "browser",
  target: ["chrome120"],
  outfile: path.join(extensionDir, "dist", "math-ocr.js"),
  legalComments: "eof",
});

await build({
  entryPoints: [path.join(extensionDir, "table-ocr.js")],
  bundle: true,
  minify: true,
  format: "esm",
  platform: "browser",
  target: ["chrome120"],
  outfile: path.join(extensionDir, "dist", "table-ocr.js"),
  legalComments: "eof",
});

await build({
  entryPoints: [path.join(extensionDir, "katex-render.js")],
  bundle: true,
  minify: true,
  format: "esm",
  platform: "browser",
  target: ["chrome120"],
  outfile: path.join(extensionDir, "dist", "katex-render.js"),
  legalComments: "eof",
});

await build({
  entryPoints: [path.join(extensionDir, "library-store.js")],
  bundle: true,
  minify: true,
  format: "esm",
  platform: "browser",
  target: ["chrome120"],
  outfile: path.join(extensionDir, "dist", "library-store.js"),
  legalComments: "eof",
});

await build({
  entryPoints: [path.join(extensionDir, "embedding-worker.js")],
  bundle: true,
  minify: true,
  format: "esm",
  platform: "browser",
  target: ["chrome120"],
  outfile: path.join(extensionDir, "dist", "embedding-worker.js"),
  legalComments: "eof",
});

await build({
  entryPoints: [path.join(extensionDir, "library.js")],
  bundle: true,
  minify: true,
  format: "esm",
  platform: "browser",
  target: ["chrome120"],
  outfile: path.join(extensionDir, "dist", "library.js"),
  legalComments: "eof",
});

await copyFile(path.join(extensionDir, "node_modules", "katex", "dist", "katex.min.css"), path.join(extensionDir, "katex.css"));
for (const file of ["KaTeX_AMS-Regular.woff2", "KaTeX_Caligraphic-Bold.woff2", "KaTeX_Caligraphic-Regular.woff2", "KaTeX_Fraktur-Bold.woff2", "KaTeX_Fraktur-Regular.woff2", "KaTeX_Main-Bold.woff2", "KaTeX_Main-BoldItalic.woff2", "KaTeX_Main-Italic.woff2", "KaTeX_Main-Regular.woff2", "KaTeX_Math-BoldItalic.woff2", "KaTeX_Math-Italic.woff2", "KaTeX_SansSerif-Bold.woff2", "KaTeX_SansSerif-Italic.woff2", "KaTeX_SansSerif-Regular.woff2", "KaTeX_Script-Regular.woff2", "KaTeX_Size1-Regular.woff2", "KaTeX_Size2-Regular.woff2", "KaTeX_Size3-Regular.woff2", "KaTeX_Size4-Regular.woff2", "KaTeX_Typewriter-Regular.woff2"]) {
  await copyFile(path.join(extensionDir, "node_modules", "katex", "dist", "fonts", file), path.join(extensionDir, "fonts", file));
}

await copyFile(
  path.join(extensionDir, "node_modules", "onnxruntime-web", "dist", "ort-wasm-simd-threaded.asyncify.wasm"),
  path.join(extensionDir, "dist", "ort-wasm-simd-threaded.asyncify.wasm"),
);
await copyFile(
  path.join(extensionDir, "node_modules", "onnxruntime-web", "dist", "ort-wasm-simd-threaded.wasm"),
  path.join(extensionDir, "dist", "ort-wasm-simd-threaded.wasm"),
);
await copyFile(
  path.join(extensionDir, "node_modules", "onnxruntime-web", "dist", "ort-wasm-simd-threaded.mjs"),
  path.join(extensionDir, "dist", "ort-wasm-simd-threaded.mjs"),
);
for (const file of ["ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm", "ort-wasm-simd-threaded.jsep.mjs", "ort-wasm-simd-threaded.jsep.wasm"]) {
  await copyFile(
    path.join(extensionDir, "node_modules", "@huggingface", "transformers", "node_modules", "onnxruntime-web", "dist", file),
    path.join(extensionDir, "dist", "math-runtime", file),
  );
}

console.log("Built local Readability and TTS runtimes");
