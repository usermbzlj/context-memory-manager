# Contributing

Use Node >=22.16 (the first Node 22 release whose `node:sqlite` includes FTS5). Runtime dependencies are deliberately empty.

```sh
npm ci --ignore-scripts
npm test
npm run test:pack
```

Changes to archive identity, migrations, cleanup, projection or an adapter require a regression test.
Host-specific behavior belongs in `src/integrations`, not in the storage layer. Use recorded,
redacted contracts or synthetic fixtures. Real host smoke tests are a separate release gate:
a fake provider or plugin factory is not evidence of live compatibility.

Preserve original tool data before changing visibility. Never alter a user message, assistant
prose, permissions, approval policy, or a native tool invocation. Do not retry side-effecting
tools on a timeout. A candidate excerpt is not a tokenizer measurement or proof of billing savings.

Keep fixes small and demonstrated. The existing local dashboard is in scope; new product surface
there or elsewhere needs evidence of a reproducible user problem. Avoid accounts, mandatory
models, vector databases or generic frameworks.

`npm test` and `npm run build` include the Vite web build, so they need devDependencies
(`npm ci`, not a production-only install). For parallel work, an isolated build is possible with
`npx tsc --outDir .build/<name>` plus `vite build --outDir` to a matching directory; `.build/` is
ignored by Git.
