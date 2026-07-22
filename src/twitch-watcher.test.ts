import { expect, test } from "bun:test";
import { logger } from "./logger.ts";
import type { TwitchGroupRef } from "./teamspeak.ts";
import { TwitchWatcher } from "./twitch-watcher.ts";

logger.level = 0; // keep test output quiet

const LIVE_SGID = "200";
const OTHER_SGID = "100"; // e.g. the Broadcast Box 🔴 group — must never be touched.

interface FakeGroup {
  username: string;
  members: string[];
}

function makeTeamspeak(
  liveMembers: string[],
  twitchGroups: FakeGroup[],
  clients: { nickname: string; databaseId: string; channelId?: string }[],
) {
  const liveSet = new Set(liveMembers);
  const added: { databaseId: string; sgid: string }[] = [];
  const removed: { databaseId: string; sgid: string }[] = [];
  const messages: { channelId: string; text: string }[] = [];
  let clientFetches = 0;

  const ts = {
    listTwitchGroups: async (prefix: string): Promise<TwitchGroupRef[]> =>
      twitchGroups.map((group, index) => ({
        sgid: `tw-${index}`,
        name: `${prefix}${group.username}`,
        username: group.username,
        members: new Set(group.members),
      })),
    listGroupMemberDbids: async (_sgid: string) => new Set(liveSet),
    listClients: async () => {
      clientFetches++;
      return clients.map((client) => ({ channelId: "1", ...client }));
    },
    sendChannelMessage: async (channelId: string, text: string) => {
      messages.push({ channelId, text });
    },
    addClientToGroup: async (databaseId: string, sgid: string) => {
      added.push({ databaseId, sgid });
      liveSet.add(databaseId);
    },
    removeClientFromGroup: async (databaseId: string, sgid: string) => {
      removed.push({ databaseId, sgid });
      liveSet.delete(databaseId);
    },
  };

  return { ts, added, removed, messages, clientFetches: () => clientFetches };
}

function makeTwitch(liveUsernames: string[]) {
  const calls: string[][] = [];

  return {
    twitch: {
      fetchLiveUsernames: async (usernames: string[]) => {
        calls.push(usernames);
        return new Set(usernames.filter((username) => liveUsernames.includes(username)));
      },
    },
    calls: () => calls,
  };
}

function run(twitch: unknown, ts: unknown): Promise<void> {
  return new TwitchWatcher(twitch as never, ts as never, LIVE_SGID, {
    twitchGroupPrefix: "twitch.tv/",
    publicTwitchHost: "twitch.tv",
    liveMessageTemplate: "{nickname} is now live: {link}",
  }).reconcile();
}

test("go-live: adds live group members and announces in their channel", async () => {
  const { ts, added, removed, messages } = makeTeamspeak(
    [],
    [{ username: "azn", members: ["42"] }],
    [{ nickname: "Azn", databaseId: "42", channelId: "5" }],
  );
  const { twitch } = makeTwitch(["azn"]);

  await run(twitch, ts);

  expect(added).toEqual([{ databaseId: "42", sgid: LIVE_SGID }]);
  expect(removed).toEqual([]);
  expect(messages).toEqual([{ channelId: "5", text: "Azn is now live: https://twitch.tv/azn" }]);
});

test("still-live: leaves membership untouched and does not re-announce", async () => {
  const { ts, added, removed, messages } = makeTeamspeak(
    ["42"],
    [{ username: "azn", members: ["42"] }],
    [{ nickname: "azn", databaseId: "42" }],
  );
  const { twitch } = makeTwitch(["azn"]);

  await run(twitch, ts);

  expect(added).toEqual([]);
  expect(removed).toEqual([]);
  expect(messages).toEqual([]);
});

test("stop: removes members whose channel is no longer live", async () => {
  const { ts, added, removed } = makeTeamspeak(
    ["42"],
    [{ username: "azn", members: ["42"] }],
    [{ nickname: "azn", databaseId: "42" }],
  );
  const { twitch } = makeTwitch([]); // azn no longer live

  await run(twitch, ts);

  expect(added).toEqual([]);
  expect(removed).toEqual([{ databaseId: "42", sgid: LIVE_SGID }]);
});

test("offline member is still tagged but not announced", async () => {
  const { ts, added, messages } = makeTeamspeak(
    [],
    [{ username: "azn", members: ["99"] }],
    [], // dbid 99 is not connected
  );
  const { twitch } = makeTwitch(["azn"]);

  await run(twitch, ts);

  expect(added).toEqual([{ databaseId: "99", sgid: LIVE_SGID }]);
  expect(messages).toEqual([]);
});

test("dedupes duplicate usernames into a single Twitch query", async () => {
  const { ts, added } = makeTeamspeak(
    [],
    [
      { username: "azn", members: ["1"] },
      { username: "azn", members: ["2"] },
    ],
    [],
  );
  const { twitch, calls } = makeTwitch(["azn"]);

  await run(twitch, ts);

  expect(calls()).toEqual([["azn"]]);
  expect(added.map((entry) => entry.databaseId).sort()).toEqual(["1", "2"]);
});

test("only live groups' members are tagged; offline groups' members removed", async () => {
  const { ts, added, removed } = makeTeamspeak(
    ["7"], // bob's member currently tagged
    [
      { username: "azn", members: ["42"] },
      { username: "bob", members: ["7"] },
    ],
    [],
  );
  const { twitch } = makeTwitch(["azn"]); // only azn is live

  await run(twitch, ts);

  expect(added).toEqual([{ databaseId: "42", sgid: LIVE_SGID }]);
  expect(removed).toEqual([{ databaseId: "7", sgid: LIVE_SGID }]);
});

test("no twitch.tv/ groups: clears the live group and never calls Twitch", async () => {
  const { ts, removed } = makeTeamspeak(["5"], [], []);
  const { twitch, calls } = makeTwitch(["azn"]);

  await run(twitch, ts);

  expect(removed).toEqual([{ databaseId: "5", sgid: LIVE_SGID }]);
  expect(calls()).toEqual([]);
});

test("membership operations only ever touch the Twitch live group sgid", async () => {
  const { ts, added, removed } = makeTeamspeak(["7"], [{ username: "azn", members: ["42"] }], []);
  const { twitch } = makeTwitch(["azn"]);

  await run(twitch, ts);

  for (const entry of [...added, ...removed]) {
    expect(entry.sgid).toBe(LIVE_SGID);
    expect(entry.sgid).not.toBe(OTHER_SGID);
  }
});
