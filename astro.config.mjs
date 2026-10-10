// @ts-check
import { defineConfig, fontProviders } from 'astro/config';
import { loadEnv } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import sitemap from '@astrojs/sitemap';

// .env files are not loaded into process.env for the config file, so read them explicitly.
const env = loadEnv(process.env.NODE_ENV ?? 'production', process.cwd(), '');

// Deployed as a GitHub Pages *project* site: https://bitsnexus.github.io/VideoTester/
const site = env.PUBLIC_SITE_URL || 'https://bitsnexus.github.io';
const base = env.PUBLIC_BASE_PATH || '/VideoTester';

export default defineConfig({
  site,
  base,
  trailingSlash: 'always',
  compressHTML: true,

  // GitHub Pages can't send headers, so Astro emits the CSP as a <meta> tag with hashes for
  // every script and style it renders. `connect-src 'none'` + `form-action 'none'` mean the page
  // cannot send data anywhere (fetch, XHR, WebSocket, beacon, forms) — a selected file can't be
  // uploaded. `media-src blob:` plays local files; `https: http:` lets the URL checker load a video
  // straight from its own server into <video>, exactly like another website embedding it would.
  security: {
    csp: {
      directives: [
        "default-src 'self'",
        "media-src 'self' blob: https: http:",
        "img-src 'self' data:",
        "font-src 'self'",
        "connect-src 'none'",
        "worker-src 'none'",
        "form-action 'none'",
        "base-uri 'self'",
        "object-src 'none'",
      ],
    },
  },

  integrations: [sitemap({ filter: (page) => !/\/404\/?$/.test(page) })],

  fonts: [
    {
      provider: fontProviders.google(),
      name: 'DM Sans',
      cssVariable: '--font-dm-sans',
      weights: ['400 700'],
      styles: ['normal'],
      subsets: ['latin'],
      fallbacks: ['ui-sans-serif', 'system-ui', 'sans-serif'],
    },
  ],

  vite: {
    plugins: [tailwindcss()],
  },
});
