# Frontend server dependencies

This package defines the deployment dependencies for `../server.js`.
Keep its dependency ranges and Node engine equal to the app manifest.
Commit both this manifest and its npm lock.

To update this lock from the repository root, run:

```sh
npm install --package-lock-only --ignore-scripts --no-audit --no-fund --workspaces=false --prefix bitCaster-app/server-runtime
```

Install the server with `npm ci --omit=dev --ignore-scripts --no-audit --no-fund`.
Do not resolve a new dependency graph during deployment.
These dependencies do not require install scripts.
