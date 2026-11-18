import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    proxy: {
      // Demo AI expansion: the browser only talks to the dev server, which relays to OpenAI
      // (direct browser connections dropped during the long image generation).
      '/openai': {
        target: 'https://api.openai.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/openai/, '')
      }
    }
  },
  build: {
    outDir: 'dist/player',
    lib: {
      entry: 'src/core/player.js',
      formats: ['es'],
      fileName: () => 'parajaca-player.js'
    }
  }
});
