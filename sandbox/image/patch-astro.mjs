// Volar returns null for colorless documents; LSP documentColor requires an array.
// Keep this compatibility fix in the pinned sandbox tool, not Zed's shared LSP client.
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const require = createRequire(resolve(process.argv[2], "@astrojs/language-server/package.json"));
const file = require.resolve("@volar/language-server/lib/features/languageFeatures.js");
const source = readFileSync(file, "utf8");
const original = "return languageService.getDocumentColors(uri, token);";
if (source.split(original).length !== 2) throw new Error("Astro/Volar changed: review the documentColor patch");
writeFileSync(file, source.replace(original, "return Promise.resolve(languageService.getDocumentColors(uri, token)).then(colors => colors ?? []);"));
