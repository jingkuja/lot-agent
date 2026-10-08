# AGENTS.md

## Read as Needed

- To understand project features, architecture, code entry points, or execution flows, read [Project Architecture and Code Navigation](docs/agent-code-guide.md), then consult the task-specific documents linked there.
- For small tasks with a known change location, read the relevant implementation and tests directly; there is no need to load all project documentation every time.
- Treat the current code and tests as the source of truth for functionality, `package.json` for commands, and `.env.example` for configuration guidance.

## Development Conventions

- Before starting, check `git status --short` and preserve the user's existing changes; modify only what the current task requires.
- Use pnpm, retain `.js` extensions in TypeScript / ESM imports, and use 2-space indentation.
- Define interfaces for DB / Redis-dependent capabilities in core and implement them in server; do not add `pg` / `ioredis` to core.
- Add database changes to `packages/server/src/db/migrations/` and register them in `index.ts`; do not modify historical migrations that have already run. Explicitly convert PG `NUMERIC` values before calculations.
- Use existing CSS variables for web colors instead of hardcoded hex / rgba values; check the dark theme and both Chinese and English copy.
- Interactive tools that wait for a user reply must use `endsTurn: true`; update the frontend cards and message persistence together.

## Required Safeguards

- Validate user ownership and tool execution allowlists on the server; isolate model credentials, billing, and memory by user / request.
- Preserve tool input schema validation, the file sandbox, network SSRF protection, and cancellation; do not blindly retry write tools.
- Never commit secrets to Git or expose them to clients or logs; return generic login failure errors to clients and disable `DEBUG=1` in production.

## Validation and Delivery

- Run tests and builds relevant to the scope of the changes, and report actual validation results; for documentation-only changes, checking content, paths, and links is sufficient.
- Update `docs/agent-code-guide.md` when feature entry points or architecture change; keep this file limited to brief development conventions.
- Keep the conventions in `AGENTS.md` and `CLAUDE.md` consistent.
