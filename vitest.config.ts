import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@\/(.*)\.mjs$/,
        replacement: path.join(root, '$1.mts'),
      },
      {
        find: /^@\/(.*)$/,
        replacement: path.join(root, '$1'),
      },
    ],
  },
  test: {
    environment: 'node',
  },
});
