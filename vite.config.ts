import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const configured = (process.env.PUBLIC_SITE_URL || env.PUBLIC_SITE_URL)?.trim().replace(/\/$/, '') || '';
  const publicSiteUrl = /^https?:\/\/[^\s]+$/.test(configured) ? configured : '';
  return {
    plugins: [react(), tailwindcss(), {
      name: 'soundproof-public-url',
      transformIndexHtml(html) {
        const transformed = html.replaceAll('__SOUNDPROOF_SITE_URL__', publicSiteUrl);
        return publicSiteUrl ? transformed : transformed.replace(/^\s*<[^>]+data-public-url[^>]*>\s*$/gm, '');
      },
    }],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
