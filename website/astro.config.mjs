import { defineConfig } from 'astro/config';

// Deployed to GitHub Pages from the EpilepsyCenter org.
// Final URL: https://epilepsycenter.github.io/tracer/
//
// If you point a custom domain at this site (e.g. tracer.app), drop the
// `base` line and update `site` to the apex — Astro will rewrite all
// internal links accordingly.
export default defineConfig({
  site: 'https://epilepsycenter.github.io',
  base: '/tracer',
  trailingSlash: 'ignore',
});
