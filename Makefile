.PHONY: install dev typecheck test deploy schema-local schema-remote errors

# Install dependencies.
install:
	npm install

# Local dev server on :8787.
dev:
	npx wrangler dev

# Type-check only; no emit (wrangler bundles separately).
typecheck:
	npx tsc --noEmit

# Run the test suite. Node strips the TypeScript types natively (no build step).
test:
	node --disable-warning=ExperimentalWarning --test test/*.test.ts

# Deploy to Cloudflare. Type-checks and tests first; either failing aborts it.
deploy: typecheck test
	npx wrangler deploy

# Apply the D1 schema locally.
schema-local:
	npx wrangler d1 execute newsletters --file=./schema.sql

# Apply the D1 schema to production.
schema-remote:
	npx wrangler d1 execute newsletters --file=./schema.sql --remote

# Inspect recorded failures in production.
errors:
	npx wrangler d1 execute newsletters --remote --command "SELECT id, reason, subject FROM errors"
