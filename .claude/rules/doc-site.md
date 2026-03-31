---
paths:
  - "bitCaster-doc/**/*"
---

# Documentation Site (bitCaster-doc)

Astro Starlight documentation site.

```bash
cd bitCaster-doc
npm run dev          # Astro dev server
npm run build        # static build to dist/
npm run preview      # preview production build
```

- Themed with bitCaster design tokens (bitcoin orange `#f7931a`, slate neutrals, Inter + JetBrains Mono)
- Sidebar auto-generated from `src/content/docs/` directory structure
- Deployed to GitHub Pages via `.github/workflows/deploy-docs.yml` on push to `main`
- Uses Starlight's CSS custom property system (`--sl-*`), not Tailwind
- **i18n**: Supports English (root locale) and Japanese (`ja/`). Whenever content is updated in one language, all other languages must be updated to stay in sync. English content lives at `src/content/docs/`, Japanese at `src/content/docs/ja/`. Sidebar group labels are translated in `astro.config.mjs` via `translations` properties.
- Try not to leave the "Smell" of the AI-generated document, e.g. list of items with emphasized headline.
