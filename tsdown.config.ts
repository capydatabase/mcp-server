import { defineConfig } from 'tsdown'

export default defineConfig({
  // index: the stdio bin. http: the remote handler (exercised by test/). vercel: the hosted
  // deployment's configured handler, imported by api/*.js.
  entry: ['src/index.ts', 'src/http.ts', 'src/vercel.ts'],
  dts: false,
  format: ['esm'],
  clean: true,
  platform: 'node',
  // package.json `bin` points at dist/index.js; the package is ESM via "type": "module".
  fixedExtension: false,
})
