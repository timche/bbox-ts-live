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

/**
 * An optional environment variable with no fallback: `undefined` when unset or
 * blank. Used for the credentials whose presence gates an optional feature.
 */
function optionalSecretEnv() {
  return z.preprocess(blankToUndefined, z.string().optional());
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
 * The service has two independent features — Broadcast Box and Twitch — each
 * enabled only when its own variables are set. At least one must be configured;
 * a partially-configured feature is rejected up front. Secret values are never
 * echoed back in validation errors.
 */
export const configSchema = z
  .object({
    // ---- Broadcast Box (optional feature) ----
    BROADCAST_BOX_API_URL: optionalSecretEnv(),
    BROADCAST_BOX_ADMIN_TOKEN: optionalSecretEnv(),
    PUBLIC_STREAM_HOST: optionalSecretEnv(),
    LIVE_GROUP_NAME: optionalEnv("🔴"),
    STREAM_GROUP_PREFIX: optionalEnv("📺"),
    // Not `optionalEnv`: an explicit blank value must survive as "" (disabled)
    // rather than falling back to the default template.
    LIVE_MESSAGE_TEMPLATE: z.string().default("{nickname} is now live: {link}"),

    // ---- Twitch (optional feature) ----
    TWITCH_CLIENT_ID: optionalSecretEnv(),
    TWITCH_CLIENT_SECRET: optionalSecretEnv(),
    TWITCH_LIVE_GROUP_NAME: optionalEnv("🟣"),
    TWITCH_GROUP_PREFIX: optionalEnv("twitch.tv/"),
    // Same blank-disables semantics as LIVE_MESSAGE_TEMPLATE.
    TWITCH_LIVE_MESSAGE_TEMPLATE: z.string().default("{nickname} is now live: {link}"),

    // ---- TeamSpeak ServerQuery (always required) ----
    TEAMSPEAK_HOST: requiredEnv("TEAMSPEAK_HOST"),
    TEAMSPEAK_QUERY_PORT: integerEnv("TEAMSPEAK_QUERY_PORT", 10_011),
    TEAMSPEAK_SERVER_PORT: integerEnv("TEAMSPEAK_SERVER_PORT", 9987),
    TEAMSPEAK_QUERY_USERNAME: optionalEnv("serveradmin"),
    TEAMSPEAK_QUERY_PASSWORD: requiredEnv("TEAMSPEAK_QUERY_PASSWORD"),
    TEAMSPEAK_QUERY_NICKNAME: optionalEnv("bbox-ts-live"),

    POLL_INTERVAL_MS: integerEnv("POLL_INTERVAL_MS", 10_000),
  })
  .superRefine((env, ctx) => {
    const broadcastBoxVars = {
      BROADCAST_BOX_API_URL: env.BROADCAST_BOX_API_URL,
      BROADCAST_BOX_ADMIN_TOKEN: env.BROADCAST_BOX_ADMIN_TOKEN,
      PUBLIC_STREAM_HOST: env.PUBLIC_STREAM_HOST,
    };
    const broadcastBoxSet = Object.values(broadcastBoxVars).filter(
      (value) => value !== undefined,
    ).length;
    if (broadcastBoxSet > 0 && broadcastBoxSet < Object.keys(broadcastBoxVars).length) {
      const missing = Object.entries(broadcastBoxVars)
        .filter(([, value]) => value === undefined)
        .map(([key]) => key);
      ctx.addIssue({
        code: "custom",
        message: `Broadcast Box is partially configured; also set: ${missing.join(", ")}`,
      });
    }

    const twitchSet =
      (env.TWITCH_CLIENT_ID !== undefined ? 1 : 0) +
      (env.TWITCH_CLIENT_SECRET !== undefined ? 1 : 0);
    if (twitchSet === 1) {
      ctx.addIssue({
        code: "custom",
        message: "TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET must be set together",
      });
    }

    if (broadcastBoxSet === 0 && twitchSet === 0) {
      ctx.addIssue({
        code: "custom",
        message:
          "No feature configured: set the BROADCAST_BOX_* variables, the TWITCH_* variables, or both",
      });
    }
  })
  .transform((env) => ({
    /**
     * Broadcast Box feature config, or `undefined` when the feature is not
     * configured. Its presence is the enabled flag.
     */
    broadcastBox:
      env.BROADCAST_BOX_API_URL !== undefined &&
      env.BROADCAST_BOX_ADMIN_TOKEN !== undefined &&
      env.PUBLIC_STREAM_HOST !== undefined
        ? {
            apiUrl: env.BROADCAST_BOX_API_URL.replace(/\/+$/, ""),
            // The env var holds the token in cleartext; Broadcast Box expects it
            // base64-encoded in the Authorization header.
            authorization: `Bearer ${Buffer.from(env.BROADCAST_BOX_ADMIN_TOKEN, "utf8").toString("base64")}`,
            /** Public host used in the per-user stream-link group name, e.g. `stream.example.com`. */
            publicStreamHost: env.PUBLIC_STREAM_HOST.replace(/^https?:\/\//, "").replace(
              /\/+$/,
              "",
            ),
            /** Name of the shared "live" group (shown before the nickname in the tree). */
            liveGroupName: env.LIVE_GROUP_NAME,
            /** Prefix for the per-user stream-link groups, e.g. `📺 stream.example.com/alice`. */
            streamGroupPrefix: env.STREAM_GROUP_PREFIX,
            /**
             * Template for the go-live channel message. Supports `{nickname}`
             * (the TeamSpeak nickname) and `{link}` (the public stream URL). Set
             * it blank to disable the announcement.
             */
            liveMessageTemplate: env.LIVE_MESSAGE_TEMPLATE,
          }
        : undefined,
    /**
     * Twitch feature config, or `undefined` when the feature is not configured.
     * Its presence is the enabled flag.
     */
    twitch:
      env.TWITCH_CLIENT_ID !== undefined && env.TWITCH_CLIENT_SECRET !== undefined
        ? {
            clientId: env.TWITCH_CLIENT_ID,
            clientSecret: env.TWITCH_CLIENT_SECRET,
            /** Name of the shared Twitch "live" group (shown before the nickname). */
            liveGroupName: env.TWITCH_LIVE_GROUP_NAME,
            /** Prefix of the pre-assigned per-user Twitch groups, e.g. `twitch.tv/alice`. */
            twitchGroupPrefix: env.TWITCH_GROUP_PREFIX,
            /** Public host used to build the Twitch link in the announcement. */
            publicTwitchHost: "twitch.tv",
            /**
             * Template for the go-live channel message. Supports `{nickname}`
             * and `{link}` (the public Twitch URL). Set it blank to disable.
             */
            liveMessageTemplate: env.TWITCH_LIVE_MESSAGE_TEMPLATE,
          }
        : undefined,
    teamspeak: {
      host: env.TEAMSPEAK_HOST,
      queryPort: env.TEAMSPEAK_QUERY_PORT,
      serverPort: env.TEAMSPEAK_SERVER_PORT,
      username: env.TEAMSPEAK_QUERY_USERNAME,
      password: env.TEAMSPEAK_QUERY_PASSWORD,
      nickname: env.TEAMSPEAK_QUERY_NICKNAME,
    },
    pollIntervalMs: env.POLL_INTERVAL_MS,
  }));

export type Config = z.infer<typeof configSchema>;

/** The validated runtime config, evaluated once against `process.env` on startup. */
export const config: Config = configSchema.parse(process.env);
