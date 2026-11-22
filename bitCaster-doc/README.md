# bitCaster documentation site

The source of [bitcasterdoc.com](https://bitcasterdoc.com), built with [Astro Starlight](https://starlight.astro.build).
A push to `main` that changes this directory deploys the site.

```bash
npm ci
npm run dev      # local server at localhost:4321
npm run build    # static build to dist/
```

## Two sections, two readers

| Section | Directory | Reader | Style |
| --- | --- | --- | --- |
| For Humans | `src/content/docs/user-guide/` | A person who wants to understand bitCaster | Short, plain, natural prose |
| For AI | `src/content/docs/technical/` | AI agents and client developers who must act correctly | Complete and precise, as long as needed |

New detail goes to For AI. A For Humans page changes only when the reader's mental model changes,
and it stays below approximately 600 English words. Do not describe the interface step by step, and
do not state a fact in both sections. The full rules are in
[`.claude/rules/doc-site.md`](../.claude/rules/doc-site.md).

## Languages

English pages are in `src/content/docs/`. Japanese pages are in `src/content/docs/ja/` at the same path.
Change both together. Use [TERMINOLOGY.md](TERMINOLOGY.md) for product terms.

## Layout

- `astro.config.mjs` defines the sidebar and its translated labels.
- `src/components/` holds the landing page components and the diagrams.
- `src/assets/` holds images that pages import. `public/` holds static files.
