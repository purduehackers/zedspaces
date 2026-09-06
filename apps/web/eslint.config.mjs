import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    ".next-*/**",
    ".zs-dev/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Generated and vendored content (b9 §2):
    "drizzle/**",
    "public/editor/**",
    "public/sw.js",
    ".workflow-data/**",
    // Emitted by the Workflow DevKit next plugin on every build:
    "app/.well-known/workflow/**",
  ]),
]);

export default eslintConfig;
