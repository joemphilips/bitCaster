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
- Document only public, user-visible behavior and public contracts. Do not mirror private plans, runbooks, or implementation details. Do not cite or name private ADRs.

- Use the [terminology table](../../bitCaster-doc/TERMINOLOGY.md) for English and Japanese product terms. Keep resolution, settlement, and payment distinct.

## Two audiences

The site has two sections. Decide which section owns a fact before you write it.

- **For Humans** (`user-guide/`): a person reads these pages to understand bitCaster. Keep each page short. Give the concept, the reason, and the one thing the reader must do or avoid.
- **For AI** (`technical/`): AI agents and client developers read these pages to act correctly. Make them complete and precise. Length is not a problem there.

Apply these rules to every change:

- Put new detail in For AI by default. Detail includes CLI commands, limits, error codes, state names, retry rules, recovery rules, and edge cases.
- Change a For Humans page only when the reader's mental model changes: a new concept, a new risk, or a changed promise. Then change a sentence. Do not append a paragraph.
- Do not narrate the interface. Do not describe buttons, dialogs, spinners, notifications, or timing step by step. Name a control only when the reader cannot find the action without it.
- Do not state a fact in both sections. The For Humans page gives the short version and links to the For AI page.
- Keep each For Humans page below approximately 600 English words. If a change exceeds this limit, move detail to For AI or remove other text.
- Use a diagram for structure, flow, or sequence. Build it as a component in `src/components/` so that both languages and both themes use the same diagram.
- Write For Humans pages in natural English and natural Japanese. The Japanese page is not a literal translation. Both languages must make the same claims.
- Write For AI pages in controlled English: short sentences, one term for each concept, exact identifiers.
- The app links to `/user-guide/core-concepts/resolution/#check-the-oracle-profile` and to its Japanese anchor. Keep both headings.
- The app links to `/user-guide/core-concepts/funding-bot-liquidity/` and to its Japanese page. Keep both addresses.
- Link the app from For Humans pages where the reader can act: the markets list, the creator page, the portfolio.
- A reviewer can leave a `> Note:` block in a page. Apply the note, then remove the block. Do not publish a page that contains one.
