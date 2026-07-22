# teamspeak-stream-live

Reflects who is **live** into TeamSpeak's channel tree. It has two independent
features — [**Broadcast Box**](#broadcast-box) and [**Twitch**](#twitch) — each
enabled only when its own configuration is present. Configure one, the other, or
both (at least one is required).

## Broadcast Box

Watches a [Broadcast Box](https://github.com/Glimesh/broadcast-box) instance and, whenever a TeamSpeak user is **live**, gives that user three things:

1. Membership in a shared **live group** (`LIVE_GROUP_NAME`, default `🔴`) that the service auto-creates with _"show name in tree: before"_ — so the user shows up as e.g. `🔴 alice` in the channel tree.
2. Their own **stream-link group** named `📺 <host>/<username>` (e.g. `📺 stream.example.com/alice`), so other users can see the stream link in that user's server-group list.
3. A one-off **channel message** in the channel they're in — e.g. `alice is now live: https://stream.example.com/alice` (`LIVE_MESSAGE_TEMPLATE`; set blank to disable).

When the stream stops, the group memberships are removed again. The channel message fires once, when the user goes live — it isn't repeated on every poll, and a restart won't re-send it.

Enabled when `BROADCAST_BOX_API_URL`, `BROADCAST_BOX_ADMIN_TOKEN`, and `PUBLIC_STREAM_HOST` are all set.

## Twitch

The **reverse** of the Broadcast Box flow. Instead of matching live stream keys to nicknames, the source of truth for _who to check_ lives in TeamSpeak: users are given **pre-assigned server groups** named `twitch.tv/<username>` (e.g. `twitch.tv/azn`), created and assigned by admins. Each poll, for every such group the service asks Twitch whether `<username>` is live and, if so, gives that group's members:

1. Membership in a shared Twitch **live group** (`TWITCH_LIVE_GROUP_NAME`, default `🟣`), auto-created with the same _"show name in tree: before"_ treatment — so they show up as e.g. `🟣 azn` in the tree.
2. A one-off **channel message** — e.g. `azn is now live: https://twitch.tv/azn` (`TWITCH_LIVE_MESSAGE_TEMPLATE`; set blank to disable). Offline members of a live group still get the `🟣` prefix (it renders when they connect) but no message.

The `twitch.tv/<username>` group already exists and already advertises the link, so — unlike Broadcast Box — **no per-user group is created**; only the shared `🟣` membership is reconciled. Those identity groups are admin-owned and never created or deleted by the service.

Liveness comes from the [Twitch Helix API](https://dev.twitch.tv/docs/api/) (`GET /helix/streams`), authenticated with an **App Access Token** obtained via the client-credentials flow. Create an app at [dev.twitch.tv](https://dev.twitch.tv/console/apps) to get `TWITCH_CLIENT_ID` and `TWITCH_CLIENT_SECRET`; the token is fetched lazily, cached, and refreshed automatically on expiry. All requested usernames are batched into as few Helix calls as possible.

Enabled when both `TWITCH_CLIENT_ID` and `TWITCH_CLIENT_SECRET` are set.

A user who is live on both Broadcast Box and Twitch simply carries both prefixes (`🔴 🟣 azn`) — the two features use separate groups and never interfere.

## How it works

Both features share one TeamSpeak ServerQuery connection and one poll loop (`POLL_INTERVAL_MS`, default 10s). Each poll is a **stateless reconciliation** — no in-memory state is kept, so restarts and crashes recover automatically. Only the enabled features run each tick, and a failure in one never skips the other. On `SIGINT`/`SIGTERM` each enabled watcher empties its live group (Broadcast Box also deletes its stream-link groups) and the connection disconnects; the shared live groups themselves are left in place.

At startup the service ensures each enabled feature's shared live group exists and has _"show name in tree: before"_ enabled (TeamSpeak permission `i_group_show_name_in_tree = 1`).

### Broadcast Box

Broadcast Box is expected to run with `DISABLE_STATUS=true`, so the public `/api/status` route is off. Instead the watcher polls **`GET /api/admin/status`** using the admin bearer token. The stream key is assumed to equal the TeamSpeak nickname.

1. Fetch the set of live stream keys from `/api/admin/status`.
2. Read the shared group's current members and the existing per-user stream-link groups (names starting with `STREAM_GROUP_PREFIX`).
3. If **nothing is live**, remove all members from the live group and delete the stream-link groups, then stop — the (larger) client list is never fetched.
4. Otherwise fetch connected clients and, for every live stream that matches a connected nickname (case-insensitive), diff against the current state: add/remove live-group members and create/delete per-user stream-link groups. Still-live streamers are left untouched (no flicker). Each user who is _newly_ added to the live group (i.e. not already a member) also gets the go-live channel message; because that transition is derived from live-group membership on the server, the announcement stays stateless — one message per go-live, never repeated. Newly-live users are handled one after another, since a TeamSpeak channel message goes to the query client's current channel — the watcher moves itself into each user's channel before posting.

### Twitch

1. List the server groups whose name starts with `TWITCH_GROUP_PREFIX` (default `twitch.tv/`) and, for each, read its members and the twitch username (the part after the prefix, lowercased).
2. If **no such groups exist**, remove all members from the `🟣` group and stop — Twitch is never called (not even for a token).
3. Otherwise ask the Twitch Helix API which of those usernames are live (batched, ≤100 logins per request), then diff the union of the live groups' members against the `🟣` group's current members: add the newly-live, remove those no longer live. Still-live members are left untouched. Each _newly_-added member who is currently connected also gets the go-live channel message (offline members are tagged but not messaged); the transition is derived from `🟣` membership, so it stays stateless — one message per go-live.

## Configuration

Everything is configured via environment variables (see [`.env.example`](./.env.example)):

At least one feature (Broadcast Box or Twitch) must be configured; a feature is enabled only when **all** of its variables are set, and a half-configured feature is rejected at startup.

| Variable                       |   Required    | Default                          | Description                                                                                                                      |
| ------------------------------ | :-----------: | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `BROADCAST_BOX_API_URL`        | Broadcast Box | –                                | Internal Broadcast Box API base URL, e.g. `http://broadcast-box:8080`                                                            |
| `BROADCAST_BOX_ADMIN_TOKEN`    | Broadcast Box | –                                | Admin token in **cleartext**. Base64-encoded automatically before being sent. Must match Broadcast Box's `FRONTEND_ADMIN_TOKEN`. |
| `PUBLIC_STREAM_HOST`           | Broadcast Box | –                                | Public host used in the stream-link group name, e.g. `stream.example.com` (scheme/trailing slash stripped)                       |
| `LIVE_GROUP_NAME`              |               | `🔴`                             | Broadcast Box shared live group (auto-created, shown before the nickname in the tree)                                            |
| `STREAM_GROUP_PREFIX`          |               | `📺`                             | Prefix for the Broadcast Box per-user stream-link groups                                                                         |
| `LIVE_MESSAGE_TEMPLATE`        |               | `{nickname} is now live: {link}` | Broadcast Box go-live message. `{nickname}` = TeamSpeak nickname, `{link}` = public stream URL. Blank disables it.               |
| `TWITCH_CLIENT_ID`             |    Twitch     | –                                | Twitch app client id (create an app at dev.twitch.tv). Enables the Twitch feature together with the secret.                      |
| `TWITCH_CLIENT_SECRET`         |    Twitch     | –                                | Twitch app client secret (never logged). Must be set together with `TWITCH_CLIENT_ID`.                                           |
| `TWITCH_LIVE_GROUP_NAME`       |               | `🟣`                             | Twitch shared live group (auto-created, shown before the nickname in the tree)                                                   |
| `TWITCH_GROUP_PREFIX`          |               | `twitch.tv/`                     | Prefix of the pre-assigned per-user Twitch groups; the username is the part after it                                             |
| `TWITCH_LIVE_MESSAGE_TEMPLATE` |               | `{nickname} is now live: {link}` | Twitch go-live message. `{nickname}` = TeamSpeak nickname, `{link}` = `https://twitch.tv/<username>`. Blank disables it.         |
| `TEAMSPEAK_HOST`               |      ✅       | –                                | TeamSpeak ServerQuery host                                                                                                       |
| `TEAMSPEAK_QUERY_PORT`         |               | `10011`                          | ServerQuery (RAW) port                                                                                                           |
| `TEAMSPEAK_SERVER_PORT`        |               | `9987`                           | Voice port of the virtual server to select                                                                                       |
| `TEAMSPEAK_QUERY_USERNAME`     |               | `serveradmin`                    | ServerQuery login                                                                                                                |
| `TEAMSPEAK_QUERY_PASSWORD`     |      ✅       | –                                | ServerQuery password                                                                                                             |
| `TEAMSPEAK_QUERY_NICKNAME`     |               | `teamspeak-stream-live`          | Nickname the query client connects with                                                                                          |
| `POLL_INTERVAL_MS`             |               | `10000`                          | Reconcile interval in milliseconds (shared by both features)                                                                     |
| `LOG_LEVEL`                    |               | `info`                           | `debug` \| `info` \| `warn` \| `error`                                                                                           |

A "Required" value of _Broadcast Box_ or _Twitch_ means the variable is required only when that feature is used. The `BROADCAST_BOX_ADMIN_TOKEN` value is the token in cleartext; the watcher sends it as `Authorization: Bearer <base64(token)>`.

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
bun run build          # compile a standalone ./teamspeak-stream-live binary
```

Tooling: [`ky`](https://github.com/sindresorhus/ky) + [`zod`](https://zod.dev) for validated HTTP, [`consola`](https://github.com/unjs/consola) for logging, and [`@timche/oxc-configs`](https://www.npmjs.com/package/@timche/oxc-configs) (oxlint + oxfmt) for linting/formatting.

A [lefthook](https://lefthook.dev) `pre-commit` hook runs oxfmt and `oxlint --fix` on staged files and re-stages the results. It installs automatically via the `prepare` script on `bun install`. CI (`.github/workflows/ci.yml`) runs typecheck, lint, format check, and tests on every push and pull request.

## Docker

The image compiles the app into a single self-contained binary (embedding the Bun runtime) and ships it on a minimal `debian:bookworm-slim` base.

```sh
docker build -t teamspeak-stream-live .
docker run --rm --env-file .env teamspeak-stream-live
```

### docker compose

[`docker-compose.example.yml`](./docker-compose.example.yml) wires the watcher together with `teamspeak` and `broadcast-box` on one private network. Copy it to `docker-compose.yml`, set the secrets (e.g. via an `.env` file), then:

```sh
docker compose up -d
```

### Publishing to GitHub Container Registry

`.github/workflows/docker-publish.yml` builds and pushes a multi-arch image (`linux/amd64`, `linux/arm64`) to the GitHub Container Registry (`ghcr.io/<owner>/teamspeak-stream-live`) on `v*` tags (`git tag v0.1.0 && git push --tags`), with `:latest` tracking the newest tag. It can also be run manually via `workflow_dispatch`.

Authentication uses the built-in `GITHUB_TOKEN` (via the workflow's `packages: write` permission), so no additional secrets are required. The published package is linked to the repository automatically; make it public under the repository's package settings if you want to pull it without authentication.

## Verifying end to end

**Broadcast Box:**

1. Start the stack: `docker compose -f docker-compose.example.yml up`.
2. Connect to the TeamSpeak server with a nickname (e.g. `azn`).
3. Start streaming to Broadcast Box with the **same** stream key (`azn`).
4. Within one poll interval the tree shows `🔴 azn`, and inspecting the user reveals the `📺 <host>/azn` group.
5. Stop the stream — both are removed on the next poll.

**Twitch:**

1. Set `TWITCH_CLIENT_ID`/`TWITCH_CLIENT_SECRET` and start the service.
2. In the TeamSpeak server, create a server group named `twitch.tv/<your-twitch-login>` and assign it to your TeamSpeak identity.
3. Go live on Twitch as that channel.
4. Within one poll interval the tree shows `🟣 <you>` and the go-live message posts in your channel.
5. Stop the stream — the `🟣` prefix is removed on the next poll. (Live on both at once shows `🔴 🟣 <you>`.)

## License

MIT
