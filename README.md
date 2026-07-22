# teamspeak-broadcast-box-watcher

Watches a [Broadcast Box](https://github.com/Glimesh/broadcast-box) instance and, whenever a TeamSpeak user is **live**, assigns that user a temporary TeamSpeak server group named after their stream link — prefixed with 🔴. When the stream stops, the group is removed again.

For example, while the TeamSpeak user `azn` is streaming, they are given the group:

```
🔴 stream.example.com/azn
```

## How it works

Broadcast Box is expected to run with `DISABLE_STATUS=true`, so the public `/api/status` route is off. Instead the watcher polls **`GET /api/admin/status`** using the admin bearer token. The stream key is assumed to equal the TeamSpeak nickname (`stream.example.com/<teamspeak-username>`).

Each poll (`POLL_INTERVAL_MS`, default 10s) is a **stateless reconciliation** — the watcher keeps no in-memory state, so restarts and crashes recover automatically:

1. Fetch the set of live stream keys from `/api/admin/status`.
2. List existing temporary groups on TeamSpeak (those whose name starts with `GROUP_PREFIX`).
3. If **nothing is live**, delete any leftover temporary groups and stop — the (larger) client list is never fetched.
4. Otherwise fetch connected clients and, for every live stream that matches a connected nickname (case-insensitive):
   - **Delete** temporary groups that are no longer live (ended streams, stale/crash leftovers).
   - **Create** a group for each newly live streamer and assign the client. Groups for still-live streamers are left untouched (no flicker).

On `SIGINT`/`SIGTERM` the watcher removes all temporary groups and disconnects.

## Configuration

Everything is configured via environment variables (see [`.env.example`](./.env.example)):

| Variable                    | Required | Default             | Description                                                                                                                      |
| --------------------------- | :------: | ------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `BROADCAST_BOX_API_URL`     |    ✅    | –                   | Internal Broadcast Box API base URL, e.g. `http://broadcast-box:8080`                                                            |
| `BROADCAST_BOX_ADMIN_TOKEN` |    ✅    | –                   | Admin token in **cleartext**. Base64-encoded automatically before being sent. Must match Broadcast Box's `FRONTEND_ADMIN_TOKEN`. |
| `PUBLIC_STREAM_HOST`        |    ✅    | –                   | Public host shown in the group name, e.g. `stream.example.com` (scheme/trailing slash stripped)                                   |
| `TEAMSPEAK_HOST`            |    ✅    | –                   | TeamSpeak ServerQuery host                                                                                                       |
| `TEAMSPEAK_QUERY_PORT`      |          | `10011`             | ServerQuery (RAW) port                                                                                                           |
| `TEAMSPEAK_SERVER_PORT`     |          | `9987`              | Voice port of the virtual server to select                                                                                       |
| `TEAMSPEAK_QUERY_USERNAME`  |          | `serveradmin`       | ServerQuery login                                                                                                                |
| `TEAMSPEAK_QUERY_PASSWORD`  |    ✅    | –                   | ServerQuery password                                                                                                             |
| `TEAMSPEAK_QUERY_NICKNAME`  |          | `broadcast-watcher` | Nickname the query client connects with                                                                                          |
| `POLL_INTERVAL_MS`          |          | `10000`             | Reconcile interval in milliseconds                                                                                               |
| `GROUP_PREFIX`              |          | `🔴`                | Prefix for the temporary group name                                                                                              |
| `LOG_LEVEL`                 |          | `info`              | `debug` \| `info` \| `warn` \| `error`                                                                                           |

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
bun run build          # compile a standalone ./watcher binary
```

Tooling: [`ky`](https://github.com/sindresorhus/ky) + [`zod`](https://zod.dev) for validated HTTP, [`consola`](https://github.com/unjs/consola) for logging, and [`@timche/oxc-configs`](https://www.npmjs.com/package/@timche/oxc-configs) (oxlint + oxfmt) for linting/formatting.

A [lefthook](https://lefthook.dev) `pre-commit` hook runs oxfmt and `oxlint --fix` on staged files and re-stages the results. It installs automatically via the `prepare` script on `bun install`. CI (`.github/workflows/ci.yml`) runs typecheck, lint, format check, and tests on every push and pull request.

## Docker

The image compiles the app into a single self-contained binary (embedding the Bun runtime) and ships it on a minimal `debian:bookworm-slim` base.

```sh
docker build -t teamspeak-broadcast-box-watcher .
docker run --rm --env-file .env teamspeak-broadcast-box-watcher
```

### docker compose

[`docker-compose.example.yml`](./docker-compose.example.yml) wires the watcher together with `teamspeak` and `broadcast-box` on one private network. Copy it to `docker-compose.yml`, set the secrets (e.g. via an `.env` file), then:

```sh
docker compose up -d
```

### Publishing to Docker Hub

`.github/workflows/docker-publish.yml` builds and pushes a multi-arch image (`linux/amd64`, `linux/arm64`) to Docker Hub on pushes to `main` and on `v*` tags. Configure these repository settings:

- **Variable** `DOCKERHUB_USERNAME` — your Docker Hub username (used for the image name).
- **Secret** `DOCKERHUB_USERNAME` — same username, for login.
- **Secret** `DOCKERHUB_TOKEN` — a Docker Hub access token.

## Verifying end to end

1. Start the stack: `docker compose -f docker-compose.example.yml up`.
2. Connect to the TeamSpeak server with a nickname (e.g. `azn`).
3. Start streaming to Broadcast Box with the **same** stream key (`azn`).
4. Within one poll interval the user gets the `🔴 <host>/azn` group.
5. Stop the stream — the group is removed on the next poll.

## License

MIT
