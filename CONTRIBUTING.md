# Contributing

Use Node >=22.13. Runtime dependencies are deliberately empty.

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

Keep fixes small and demonstrated. Avoid adding dashboards, accounts, mandatory models,
vector databases or generic frameworks unless a reproducible user problem requires them.
