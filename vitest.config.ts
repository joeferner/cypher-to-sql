import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // The examples import the package by name; test them against the source.
    alias: { 'cypher-to-sql': fileURLToPath(new URL('./src/index.ts', import.meta.url)) },
  },
});
