---
paths:
  - "bitCaster-doc/**/*"
---

# Documentation Site (bitCaster-doc)

Astro Starlight site deployed to `bitcasterdoc.com` via GitHub Pages (`.github/workflows/deploy-docs.yml` on push to `main`).

```bash
cd bitCaster-doc
npm run dev          # Astro dev server
npm run build        # static build to dist/
npm run preview      # preview production build
```

- Styling uses Starlight's CSS custom properties (`--sl-*`), **not** Tailwind.
- **i18n**: English (root locale) + Japanese (`ja/`). English content in `src/content/docs/`, Japanese in `src/content/docs/ja/`. Sidebar group labels are translated in `astro.config.mjs` via the `translations` properties. Whenever content is updated in one language, update the others to stay in sync.
- Avoid the "AI-generated" smell — don't produce lists of bullets with bold headlines.
