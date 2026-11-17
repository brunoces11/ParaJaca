import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    outDir: 'dist/player',
    lib: {
      entry: 'src/core/player.js',
      formats: ['es'],
      fileName: () => 'parajaca-player.js'
    }
  }
});
