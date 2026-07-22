import ky, { HTTPError, type KyInstance } from "ky";
import { z } from "zod";
import { logger } from "./logger.ts";

const DEFAULT_HELIX_URL = "https://api.twitch.tv/helix";
const DEFAULT_TOKEN_URL = "https://id.twitch.tv/oauth2/token";

/** Max `user_login` values Twitch Helix accepts per `/streams` request. */
const MAX_LOGINS_PER_REQUEST = 100;

/** App Access Token (client-credentials) response. Only `access_token` is used. */
const tokenSchema = z
  .object({
    access_token: z.string(),
    expires_in: z.number().optional(),
    token_type: z.string().optional(),
  })
  .loose();

/**
 * `GET /helix/streams` response. A login is present in `data` only when the
 * channel is live, so the mere presence of an entry signals liveness.
 */
const streamsSchema = z
  .object({
    data: z.array(z.object({ user_login: z.string() }).loose()),
  })
  .loose();

function isUnauthorized(error: unknown): boolean {
  return error instanceof HTTPError && error.response.status === 401;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }

  return chunks;
}

/**
 * Twitch Helix client. Obtains an App Access Token via the client-credentials
 * flow, caches it, and reports which of a set of logins are currently live.
 * The token lifecycle is fully internal — callers only ever see live logins.
 */
export class TwitchClient {
  readonly #helix: KyInstance;
  readonly #tokenUrl: string;
  readonly #clientId: string;
  readonly #clientSecret: string;
  #token: string | undefined;

  constructor(options: {
    clientId: string;
    clientSecret: string;
    helixUrl?: string;
    tokenUrl?: string;
  }) {
    this.#clientId = options.clientId;
    this.#clientSecret = options.clientSecret;
    this.#tokenUrl = options.tokenUrl ?? DEFAULT_TOKEN_URL;
    this.#helix = ky.create({
      prefix: options.helixUrl ?? DEFAULT_HELIX_URL,
      headers: {
        "Client-Id": options.clientId,
        Accept: "application/json",
      },
      retry: { limit: 2 },
      timeout: 10_000,
    });
  }

  /**
   * Returns the subset of `usernames` currently live on Twitch.
   *
   * Batches into Helix requests of up to 100 logins. Empty input performs no
   * HTTP at all (not even a token fetch). The App Access Token is fetched
   * lazily on first use and refreshed once on a `401`.
   */
  async fetchLiveUsernames(usernames: string[], signal?: AbortSignal): Promise<Set<string>> {
    const live = new Set<string>();
    if (usernames.length === 0) {
      return live;
    }

    let token = await this.#ensureToken();

    for (const logins of chunk(usernames, MAX_LOGINS_PER_REQUEST)) {
      let data: z.infer<typeof streamsSchema>["data"];
      try {
        data = await this.#queryStreams(logins, token, signal);
      } catch (error) {
        if (!isUnauthorized(error)) {
          throw error;
        }
        // Token likely expired: refresh once and retry this chunk.
        token = await this.#refreshToken();
        data = await this.#queryStreams(logins, token, signal);
      }

      for (const stream of data) {
        live.add(stream.user_login.toLowerCase());
      }
    }

    logger.debug(`Twitch reports ${live.size} live channel(s)`);

    return live;
  }

  async #queryStreams(
    logins: string[],
    token: string,
    signal?: AbortSignal,
  ): Promise<z.infer<typeof streamsSchema>["data"]> {
    const searchParams = new URLSearchParams(
      logins.map((login): [string, string] => ["user_login", login]),
    );
    const response = await this.#helix
      .get("streams", {
        searchParams,
        headers: { Authorization: `Bearer ${token}` },
        signal,
      })
      .json(streamsSchema);

    return response.data;
  }

  async #ensureToken(): Promise<string> {
    if (this.#token !== undefined) {
      return this.#token;
    }

    return this.#refreshToken();
  }

  async #refreshToken(): Promise<string> {
    const body = new URLSearchParams({
      client_id: this.#clientId,
      client_secret: this.#clientSecret,
      grant_type: "client_credentials",
    });
    const { access_token } = await ky
      .post(this.#tokenUrl, { body, retry: { limit: 2 }, timeout: 10_000 })
      .json(tokenSchema);
    this.#token = access_token;
    logger.debug("Obtained a Twitch app access token");

    return access_token;
  }
}
