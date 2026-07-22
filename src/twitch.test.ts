import { expect, test } from "bun:test";
import { logger } from "./logger.ts";
import { TwitchClient } from "./twitch.ts";

logger.level = 0; // keep test output quiet

const CLIENT_ID = "client-id";
const CLIENT_SECRET = "client-secret";

/**
 * Spins up a fake Twitch that serves the token endpoint at `/oauth2/token` and
 * the streams endpoint at `/streams`. `liveLogins` (lowercased) drives which
 * requested logins come back as live.
 */
function makeServer(options: {
  liveLogins: string[];
  /** Reject `/streams` with 401 until a token issued after this many token calls is used. */
  unauthorizedUntilTokenNo?: number;
}) {
  const live = new Set(options.liveLogins.map((login) => login.toLowerCase()));
  let tokenCalls = 0;
  let streamCalls = 0;
  const streamLoginCounts: number[] = [];
  let totalRequests = 0;

  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      totalRequests++;
      const url = new URL(request.url);

      if (url.pathname.endsWith("/oauth2/token")) {
        tokenCalls++;
        const body = await request.text();
        // Sanity-check the client-credentials form body.
        expect(body).toContain("grant_type=client_credentials");

        return Response.json({ access_token: `token-${tokenCalls}`, expires_in: 3600 });
      }

      if (url.pathname.endsWith("/streams")) {
        streamCalls++;
        const authToken = (request.headers.get("authorization") ?? "").replace("Bearer ", "");
        const tokenNo = Number(authToken.replace("token-", ""));

        if (
          options.unauthorizedUntilTokenNo !== undefined &&
          tokenNo < options.unauthorizedUntilTokenNo
        ) {
          return new Response("unauthorized", { status: 401 });
        }

        const logins = url.searchParams.getAll("user_login");
        streamLoginCounts.push(logins.length);
        const data = logins
          .filter((login) => live.has(login.toLowerCase()))
          .map((login) => ({ user_login: login.toLowerCase() }));

        return Response.json({ data });
      }

      return new Response("not found", { status: 404 });
    },
  });

  const client = new TwitchClient({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    helixUrl: server.url.origin,
    tokenUrl: `${server.url.origin}/oauth2/token`,
  });

  return {
    client,
    server,
    tokenCalls: () => tokenCalls,
    streamCalls: () => streamCalls,
    streamLoginCounts: () => streamLoginCounts,
    totalRequests: () => totalRequests,
  };
}

test("fetches a token, sends Client-Id + Bearer, and filters to live channels", async () => {
  let seenClientId = "";
  const live = new Set(["azn"]);
  let tokenCalls = 0;
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/oauth2/token")) {
        tokenCalls++;
        return Response.json({ access_token: "abc" });
      }
      seenClientId = request.headers.get("client-id") ?? "";
      expect(request.headers.get("authorization")).toBe("Bearer abc");
      const logins = url.searchParams.getAll("user_login");
      return Response.json({
        data: logins.filter((l) => live.has(l)).map((l) => ({ user_login: l })),
      });
    },
  });

  const client = new TwitchClient({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    helixUrl: server.url.origin,
    tokenUrl: `${server.url.origin}/oauth2/token`,
  });
  const result = await client.fetchLiveUsernames(["azn", "offline"]);
  server.stop(true);

  expect([...result]).toEqual(["azn"]);
  expect(seenClientId).toBe(CLIENT_ID);
  expect(tokenCalls).toBe(1);
});

test("empty input performs no HTTP at all", async () => {
  const harness = makeServer({ liveLogins: [] });
  const result = await harness.client.fetchLiveUsernames([]);
  harness.server.stop(true);

  expect([...result]).toEqual([]);
  expect(harness.totalRequests()).toBe(0);
});

test("fetches the token lazily on first use", async () => {
  const harness = makeServer({ liveLogins: ["azn"] });
  expect(harness.tokenCalls()).toBe(0);

  await harness.client.fetchLiveUsernames(["azn"]);
  harness.server.stop(true);

  expect(harness.tokenCalls()).toBe(1);
});

test("refreshes the token once on a 401 and retries", async () => {
  // The first token ("token-1") is rejected; the refreshed one ("token-2") works.
  const harness = makeServer({ liveLogins: ["azn"], unauthorizedUntilTokenNo: 2 });
  const result = await harness.client.fetchLiveUsernames(["azn"]);
  harness.server.stop(true);

  expect([...result]).toEqual(["azn"]);
  expect(harness.tokenCalls()).toBe(2);
});

test("batches into requests of at most 100 logins", async () => {
  const logins = Array.from({ length: 150 }, (_, index) => `user${index}`);
  const harness = makeServer({ liveLogins: ["user0", "user149"] });
  const result = await harness.client.fetchLiveUsernames(logins);
  harness.server.stop(true);

  expect([...result].sort()).toEqual(["user0", "user149"]);
  expect(harness.streamCalls()).toBe(2);
  expect(harness.streamLoginCounts()).toEqual([100, 50]);
});

test("normalizes returned logins to lowercase", async () => {
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/oauth2/token")) {
        return Response.json({ access_token: "abc" });
      }
      return Response.json({ data: [{ user_login: "AZN" }] });
    },
  });

  const client = new TwitchClient({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    helixUrl: server.url.origin,
    tokenUrl: `${server.url.origin}/oauth2/token`,
  });
  const result = await client.fetchLiveUsernames(["AZN"]);
  server.stop(true);

  expect([...result]).toEqual(["azn"]);
});
