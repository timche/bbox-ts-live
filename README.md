# bbox-ts-live

Watches a [Broadcast Box](https://github.com/Glimesh/broadcast-box) instance and, whenever a TeamSpeak user is **live**, gives that user two things:

1. Membership in a shared **live group** (`LIVE_GROUP_NAME`, default `🔴`) that the service auto-creates with _"show name in tree: before"_ — so the user shows up as e.g. `🔴 alice` in the channel tree.
2. Their own **stream-link group** named `▶️ <host>/<username>` (e.g. `▶️ stream.example.com/alice`), so other users can see the stream link in that user's server-group list.

When the stream stops, both are removed again.

## How it works

Broadcast Box is expected to run with `DISABLE_STATUS=true`, so the public `/api/status` route is off. Instead the watcher polls **`GET /api/admin/status`** using the admin bearer token. The stream key is assumed to equal the TeamSpeak nickname.

At startup the service ensures the shared live group exists and has _"show name in tree: before"_ enabled (TeamSpeak permission `i_group_show_name_in_tree = 1`).

Each poll (`POLL_INTERVAL_MS`, default 10s) is a **stateless reconciliation** — the watcher keeps no in-memory state, so restarts and crashes recover automatically:

1. Fetch the set of live stream keys from `/api/admin/status`.
2. Read the shared group's current members and the existing per-user stream-link groups (names starting with `STREAM_GROUP_PREFIX`).
3. If **nothing is live**, remove all members from the live group and delete the stream-link groups, then stop — the (larger) client list is never fetched.
4. Otherwise fetch connected clients and, for every live stream that matches a connected nickname (case-insensitive), diff against the current state: add/remove live-group members and create/delete per-user stream-link groups. Still-live streamers are left untouched (no flicker).

On `SIGINT`/`SIGTERM` the watcher empties the live group, deletes the stream-link groups, and disconnects. The shared live group itself is left in place.

## Configuration

Everything is configured via environment variables (see [`.env.example`](./.env.example)):

| Variable                    | Required | Default        | Description                                                                                                                      |
| --------------------------- | :------: | -------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `BROADCAST_BOX_API_URL`     |    ✅    | –              | Internal Broadcast Box API base URL, e.g. `http://broadcast-box:8080`                                                            |
| `BROADCAST_BOX_ADMIN_TOKEN` |    ✅    | –              | Admin token in **cleartext**. Base64-encoded automatically before being sent. Must match Broadcast Box's `FRONTEND_ADMIN_TOKEN`. |
| `PUBLIC_STREAM_HOST`        |    ✅    | –              | Public host used in the stream-link group name, e.g. `stream.example.com` (scheme/trailing slash stripped)                       |
| `TEAMSPEAK_HOST`            |    ✅    | –              | TeamSpeak ServerQuery host                                                                                                       |
| `TEAMSPEAK_QUERY_PORT`      |          | `10011`        | ServerQuery (RAW) port                                                                                                           |
| `TEAMSPEAK_SERVER_PORT`     |          | `9987`         | Voice port of the virtual server to select                                                                                       |
| `TEAMSPEAK_QUERY_USERNAME`  |          | `serveradmin`  | ServerQuery login                                                                                                                |
| `TEAMSPEAK_QUERY_PASSWORD`  |    ✅    | –              | ServerQuery password                                                                                                             |
| `TEAMSPEAK_QUERY_NICKNAME`  |          | `bbox-ts-live` | Nickname the query client connects with                                                                                          |
| `POLL_INTERVAL_MS`          |          | `10000`        | Reconcile interval in milliseconds                                                                                               |
| `LIVE_GROUP_NAME`           |          | `🔴`           | Name of the shared live group (auto-created, shown before the nickname in the tree)                                              |
| `STREAM_GROUP_PREFIX`       |          | `▶️`           | Prefix for the per-user stream-link groups                                                                                       |
| `LOG_LEVEL`                 |          | `info`         | `debug` \| `info` \| `warn` \| `error`                                                                                           |

The `BROADCAST_BOX_ADMIN_TOKEN` value is the token in cleartext; the watcher sends it as `Authorization: Bearer <base64(token)>`.

## Development

Requires [Bun](https://bun.sh).

```sh
bun install            # also installs the git hooks (lefthook)
cp .env.example .env   # fill in the values

bun run dev            # run with reload
bun run start          # run once
bun run typecheck      # tsc --noEmit
bun run lint           # oxlint
bun run lint:fix       # oxlint --fix
bun run format         # oxfmt (write) / bun run format:check
bun test               # unit tests
bun run build          # compile a standalone ./bbox-ts-live binary
```

Tooling: [`ky`](https://github.com/sindresorhus/ky) + [`zod`](https://zod.dev) for validated HTTP, [`consola`](https://github.com/unjs/consola) for logging, and [`@timche/oxc-configs`](https://www.npmjs.com/package/@timche/oxc-configs) (oxlint + oxfmt) for linting/formatting.

A [lefthook](https://lefthook.dev) `pre-commit` hook runs oxfmt and `oxlint --fix` on staged files and re-stages the results. It installs automatically via the `prepare` script on `bun install`. CI (`.github/workflows/ci.yml`) runs typecheck, lint, format check, and tests on every push and pull request.

## Docker

The image compiles the app into a single self-contained binary (embedding the Bun runtime) and ships it on a minimal `debian:bookworm-slim` base.

```sh
docker build -t bbox-ts-live .
docker run --rm --env-file .env bbox-ts-live
```

### docker compose

[`docker-compose.example.yml`](./docker-compose.example.yml) wires the watcher together with `teamspeak` and `broadcast-box` on one private network. Copy it to `docker-compose.yml`, set the secrets (e.g. via an `.env` file), then:

```sh
docker compose up -d
```

### Publishing to GitHub Container Registry

`.github/workflows/docker-publish.yml` builds and pushes a multi-arch image (`linux/amd64`, `linux/arm64`) to the GitHub Container Registry (`ghcr.io/<owner>/bbox-ts-live`) on `v*` tags (`git tag v0.1.0 && git push --tags`), with `:latest` tracking the newest tag. It can also be run manually via `workflow_dispatch`.

Authentication uses the built-in `GITHUB_TOKEN` (via the workflow's `packages: write` permission), so no additional secrets are required. The published package is linked to the repository automatically; make it public under the repository's package settings if you want to pull it without authentication.

## Verifying end to end

1. Start the stack: `docker compose -f docker-compose.example.yml up`.
2. Connect to the TeamSpeak server with a nickname (e.g. `azn`).
3. Start streaming to Broadcast Box with the **same** stream key (`azn`).
4. Within one poll interval the tree shows `🔴 azn`, and inspecting the user reveals the `▶️ <host>/azn` group.
5. Stop the stream — both are removed on the next poll.

## License

MIT
