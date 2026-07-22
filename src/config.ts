import { z } from "zod";

/**
 * Coerces empty/whitespace-only env values to `undefined` so that
 * {@link optionalEnv}/{@link integerEnv} fall back and {@link requiredEnv}
 * reports a missing variable rather than accepting a blank string.
 */
function blankToUndefined(value: unknown): unknown {
  return typeof value === "string" && value.trim() === "" ? undefined : value;
}

/** A required, non-blank environment variable. */
function requiredEnv(key: string) {
  return z.preprocess(
    blankToUndefined,
    z.string({ error: `Missing required environment variable: ${key}` }),
  );
}

/** An optional environment variable that falls back to `fallback` when unset. */
function optionalEnv(fallback: string) {
  return z.preprocess(blankToUndefined, z.string().default(fallback));
}

/** An environment variable parsed as a positive integer, defaulting to `fallback`. */
function integerEnv(key: string, fallback: number) {
  return z.preprocess(
    blankToUndefined,
    z
      .string()
      .refine((value) => Number.isInteger(Number(value)) && Number(value) > 0, {
        error: `Environment variable ${key} must be a positive integer`,
      })
      .transform((value) => Number(value))
      .default(fallback),
  );
}

/**
 * Validates the raw process environment and maps it into the runtime config.
 *
 * Every setting is env-configurable; secret values are never echoed back in
 * validation errors.
 */
export const configSchema = z
  .object({
    BROADCAST_BOX_API_URL: requiredEnv("BROADCAST_BOX_API_URL"),
    BROADCAST_BOX_ADMIN_TOKEN: requiredEnv("BROADCAST_BOX_ADMIN_TOKEN"),
    PUBLIC_STREAM_HOST: requiredEnv("PUBLIC_STREAM_HOST"),
    TEAMSPEAK_HOST: requiredEnv("TEAMSPEAK_HOST"),
    TEAMSPEAK_QUERY_PORT: integerEnv("TEAMSPEAK_QUERY_PORT", 10_011),
    TEAMSPEAK_SERVER_PORT: integerEnv("TEAMSPEAK_SERVER_PORT", 9987),
    TEAMSPEAK_QUERY_USERNAME: optionalEnv("serveradmin"),
    TEAMSPEAK_QUERY_PASSWORD: requiredEnv("TEAMSPEAK_QUERY_PASSWORD"),
    TEAMSPEAK_QUERY_NICKNAME: optionalEnv("bbox-ts-live"),
    POLL_INTERVAL_MS: integerEnv("POLL_INTERVAL_MS", 10_000),
    LIVE_GROUP_NAME: optionalEnv("🔴"),
    STREAM_GROUP_PREFIX: optionalEnv("▶️"),
  })
  .transform((env) => ({
    broadcastBox: {
      apiUrl: env.BROADCAST_BOX_API_URL.replace(/\/+$/, ""),
      // The env var holds the token in cleartext; Broadcast Box expects it
      // base64-encoded in the Authorization header.
      authorization: `Bearer ${Buffer.from(env.BROADCAST_BOX_ADMIN_TOKEN, "utf8").toString("base64")}`,
    },
    /** Public host used in the per-user stream-link group name, e.g. `stream.example.com`. */
    publicStreamHost: env.PUBLIC_STREAM_HOST.replace(/^https?:\/\//, "").replace(/\/+$/, ""),
    teamspeak: {
      host: env.TEAMSPEAK_HOST,
      queryPort: env.TEAMSPEAK_QUERY_PORT,
      serverPort: env.TEAMSPEAK_SERVER_PORT,
      username: env.TEAMSPEAK_QUERY_USERNAME,
      password: env.TEAMSPEAK_QUERY_PASSWORD,
      nickname: env.TEAMSPEAK_QUERY_NICKNAME,
    },
    pollIntervalMs: env.POLL_INTERVAL_MS,
    /** Name of the shared "live" group (shown before the nickname in the tree). */
    liveGroupName: env.LIVE_GROUP_NAME,
    /** Prefix for the per-user stream-link groups, e.g. `▶️ stream.example.com/alice`. */
    streamGroupPrefix: env.STREAM_GROUP_PREFIX,
  }));

export type Config = z.infer<typeof configSchema>;

/** The validated runtime config, evaluated once against `process.env` on startup. */
export const config: Config = configSchema.parse(process.env);
