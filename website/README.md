# TRACER website

Static marketing site for [TRACER](https://github.com/marcoledri/tracer), built with [Astro](https://astro.build).

Source for the design tokens (Telegraph theme: vellum paper, warm ink, amber LED accent, 2 px radii) lives in `src/styles/global.css`. Shared layout in `src/layouts/Base.astro`. Pages under `src/pages/`.

## Pages

- `/` — homepage
- `/features` — eleven analysis modules, expanded
- `/workflow` — six-stage tour from recording to figure
- `/docs` — short version of `docs/MANUAL.md` from the main repo

## Develop

```bash
cd website
npm install        # one-time
npm run dev        # http://localhost:4321
```

## Build

```bash
npm run build      # → website/dist/
npm run preview    # serve the built site
```

The site is fully static — `npm run build` writes plain HTML to `dist/`. Drop it on GitHub Pages, Netlify, S3, or any static host.

When you wire up a real host, set `site` and (if needed) `base` in `astro.config.mjs`. Example for GitHub Pages at `marcoledri.github.io/tracer`:

```js
export default defineConfig({
  site: 'https://marcoledri.github.io',
  base: '/tracer',
  trailingSlash: 'ignore',
});
```

## Conventions

- **Logos**: SVGs in `public/logo/` mirror the canonical files in `<repo-root>/logo/`. Update both if you rev the mark.
- **Version string**: footer + nav reference `v0.6.1` — search-and-replace on release.
- **Accuracy first**: this site advertises real features only. No fabricated benchmarks, no fabricated lab logos, no fabricated quotes. The placeholder "In labs" strip on the homepage is intentionally empty until real users opt in.
