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
