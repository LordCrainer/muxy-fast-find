import { defineConfig } from 'vite';
import { resolve } from 'path';
import { copyFileSync, existsSync, rmSync, readFileSync, writeFileSync } from 'fs';

function fixupOutputPlugin() {
  return {
    name: 'fixup-output',
    closeBundle() {
      const outDir = resolve(__dirname, 'dist');
      // Move generated panel.html to dist/panel.html
      const generatedHtml = resolve(outDir, 'src/panel/panel.html');
      const finalHtml = resolve(outDir, 'panel.html');
      if (existsSync(generatedHtml)) {
        let html = readFileSync(generatedHtml, 'utf-8');
        // Vite generates asset references like /assets/xxx. Convert to relative ./assets/xxx
        html = html.replace(/(href|src)="\/([^"]+)"/g, '$1="./$2"');
        writeFileSync(finalHtml, html);
      }
      // Remove the src/ directory that Vite created
      const srcDir = resolve(outDir, 'src');
      if (existsSync(srcDir)) {
        rmSync(srcDir, { recursive: true, force: true });
      }
      // Copy icon.svg
      const iconSrc = resolve(__dirname, 'src/assets/icon.svg');
      const iconDest = resolve(outDir, 'icon.svg');
      if (existsSync(iconSrc)) {
        copyFileSync(iconSrc, iconDest);
      }
    }
  };
}

export default defineConfig({
  plugins: [fixupOutputPlugin()],
  // Explicitly map `process.env` to an empty object so any future code that
  // accidentally reads from it (e.g. `process.env.HOME`) gets a loud
  // `undefined` access at bundle time instead of being silently inlined
  // as a minified literal in the panel bundle.
  define: {
    'process.env': '{}'
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        panel: resolve(__dirname, 'src/panel/panel.html')
      },
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]'
      }
    }
  },
  server: {
    port: 5173,
    strictPort: true
  }
});
