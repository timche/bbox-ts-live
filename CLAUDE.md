# CLAUDE.md

Project-specific rules for `teamspeak-stream-live`. See `README.md` for what the service does.

## Commands

- Run `bun run typecheck`, `bun run lint`, `bun run format`, and `bun test` before committing.
- `bun run build` compiles the standalone `teamspeak-stream-live` binary.
- Use `bun`/`bunx`, never `npm`/`node`.

## Code style

- Formatting and linting are owned by oxfmt/oxlint (config from `@timche/oxc-configs`). Never hand-format — run `bun run format`. Don't loosen the oxc configs to dodge a rule.
- oxlint forbids non-null assertions (`!`) and requires braces on every `if`/`for` — narrow types instead of asserting.
- Import local modules with the `.ts` extension: `import { logger } from "./logger.ts"`.
- Reach for a well-known library before hand-rolling (why logging is `consola`, HTTP is `ky` + `zod`).

## Conventions

- **Logging:** `import { logger } from "./logger.ts"` — one shared consola instance. No logger factory; don't pass loggers through constructors.
- **HTTP:** `ky` with a `zod` schema via `.json(schema)`; don't hand-write `fetch` + parsing.
- **Config:** all env parsing lives in `src/config.ts` (`required`/`optional`/`integer` helpers). Every setting must be env-configurable, and secrets are never logged.
- **Watcher:** keep it stateless — each poll re-reads actual state from TeamSpeak and diffs it against Broadcast Box. Don't add in-memory tracking.
- **Tests:** co-located as `src/*.test.ts`; set `logger.level = 0` to keep output quiet.

## Gotchas

- The Docker build installs with `--ignore-scripts` so the lefthook `prepare` hook doesn't run (no `.git` in the build context). Keep it.
- `docker-publish.yml` publishes on `v*` tags only, not on pushes to `main`.

## Git

- Work directly on `main`.
- Never commit secrets, real/private hostnames (use `example.com` placeholders), or build artifacts (`/teamspeak-stream-live`, `*.map`).
- If sensitive data was already committed, scrub it from history and force-push — don't just add a delete commit.
