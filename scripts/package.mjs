import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const extensionDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseDir = path.join(extensionDir, "release");
const targets = process.argv.slice(2);
const browsers = targets.length ? targets : ["chrome", "firefox"];
const supported = new Set(["chrome", "firefox"]);

if (browsers.some((browser) => !supported.has(browser))) {
  throw new Error(`Usage: node scripts/package.mjs [chrome|firefox ...]`);
}

const manifest = JSON.parse(await readFile(path.join(extensionDir, "manifest.json"), "utf8"));
const packageFiles = [
  "dist",
  "fonts",
  "icons",
  "models",
  "pdfjs",
  "pocket-tts",
  "embedding-client.js",
  "inflect-tts.js",
  "katex.css",
  "library.css",
  "library.html",
  "markdown-export.js",
  "pdfjs-pdf-worker.js",
  "pocket-tts-worker.js",
  "pocket-tts.js",
  "reader.css",
  "reader.html",
  "reader.js",
  "service-worker.js",
  "summary-client.js",
  "youtube-transcript.js",
];

await mkdir(releaseDir, { recursive: true });

for (const browser of browsers) {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), `readability-${browser}-`));
  const stagingDir = path.join(temporaryRoot, "extension");
  const archive = path.join(releaseDir, `readability-read-aloud-${browser}-${manifest.version}.zip`);

  try {
    await mkdir(stagingDir);
    await Promise.all(packageFiles.map((file) => cp(
      path.join(extensionDir, file),
      path.join(stagingDir, file),
      { recursive: true },
    )));

    const targetManifest = structuredClone(manifest);
    if (browser === "firefox") {
      targetManifest.background = { scripts: ["service-worker.js"], type: "module" };
      targetManifest.browser_specific_settings = {
        gecko: {
          id: "readability-read-aloud@local",
          strict_min_version: "121.0",
        },
      };
    }
    await writeFile(path.join(stagingDir, "manifest.json"), `${JSON.stringify(targetManifest, null, 2)}\n`);

    await rm(archive, { force: true });
    await execFileAsync("zip", ["-X", "-q", "-r", archive, "."], { cwd: stagingDir });
    console.log(`Created ${path.relative(extensionDir, archive)}`);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}
