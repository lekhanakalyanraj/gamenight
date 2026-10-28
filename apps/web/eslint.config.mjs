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
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Playwright's output (its HTML report bundles minified viewer code).
    "playwright-report/**",
    // Vendored from React Bits (see its LICENSE.md), kept close to upstream: they keep their latest props in refs,
    // a pattern the React Compiler rules flag. TypeScript still checks them.
    "src/components/react-bits/**",
    "test-results/**",
  ]),
]);

export default eslintConfig;
