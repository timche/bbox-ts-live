import { expect, test } from "bun:test";
import { config } from "./config.ts";
import { logger } from "./logger.ts";
import type { ServerGroupRef } from "./teamspeak.ts";
import { Watcher } from "./watcher.ts";

logger.level = 0; // keep test output quiet

const LIVE_SGID = "100";

function makeTeamspeak(
  members: string[],
  streamGroups: ServerGroupRef[],
  clients: { nickname: string; databaseId: string }[],
) {
  const memberSet = new Set(members);
  let groups = [...streamGroups];
  const added: string[] = [];
  const removed: string[] = [];
  const created: string[] = [];
  const deleted: string[] = [];
  let clientFetches = 0;

  const ts = {
    listGroupMemberDbids: async () => new Set(memberSet),
    listGroupsByPrefix: async (prefix: string, excludeSgid: string) =>
      groups.filter((group) => group.sgid !== excludeSgid && group.name.startsWith(prefix)),
    listClients: async () => {
      clientFetches++;
      return clients;
    },
    addClientToGroup: async (databaseId: string) => {
      added.push(databaseId);
      memberSet.add(databaseId);
    },
    removeClientFromGroup: async (databaseId: string) => {
      removed.push(databaseId);
      memberSet.delete(databaseId);
    },
    createGroupAndAssign: async (name: string) => {
      created.push(name);
      groups.push({ sgid: `new-${name}`, name });
      return `new-${name}`;
    },
    deleteGroup: async (group: ServerGroupRef) => {
      deleted.push(group.name);
      groups = groups.filter((existing) => existing.sgid !== group.sgid);
    },
    disconnect: async () => undefined,
  };

  return { ts, added, removed, created, deleted, clientFetches: () => clientFetches };
}

function streamGroup(streamKey: string): string {
  return `▶️ stream.example.com/${streamKey}`;
}

function run(
  broadcastBox: { fetchLiveStreamKeys: () => Promise<Set<string>> },
  ts: unknown,
): Promise<void> {
  return new Watcher(broadcastBox as never, ts as never, LIVE_SGID, config).reconcile();
}

test("config exposes decoupled group names and a normalized public host", () => {
  expect(config.liveGroupName).toBe("🔴");
  expect(config.streamGroupPrefix).toBe("▶️");
  expect(config.publicStreamHost).toBe("stream.example.com");
  expect(config.broadcastBox.authorization).toBe(`Bearer ${btoa("secret")}`);
});

test("go-live: adds to the shared group and creates the stream-link group", async () => {
  const broadcastBox = { fetchLiveStreamKeys: async () => new Set(["alice"]) };
  const { ts, added, created, removed, deleted } = makeTeamspeak(
    [],
    [],
    [{ nickname: "Alice", databaseId: "42" }],
  );

  await run(broadcastBox, ts);

  expect(added).toEqual(["42"]);
  expect(created).toEqual([streamGroup("alice")]);
  expect(removed).toEqual([]);
  expect(deleted).toEqual([]);
});

test("still-live: leaves membership and stream group untouched", async () => {
  const broadcastBox = { fetchLiveStreamKeys: async () => new Set(["alice"]) };
  const { ts, added, created, removed, deleted } = makeTeamspeak(
    ["42"],
    [{ sgid: "1", name: streamGroup("alice") }],
    [{ nickname: "alice", databaseId: "42" }],
  );

  await run(broadcastBox, ts);

  expect(added).toEqual([]);
  expect(created).toEqual([]);
  expect(removed).toEqual([]);
  expect(deleted).toEqual([]);
});

test("stop: removes the member and deletes their stream group", async () => {
  const broadcastBox = { fetchLiveStreamKeys: async () => new Set(["alice"]) };
  const { ts, removed, deleted, added, created } = makeTeamspeak(
    ["42", "7"],
    [
      { sgid: "1", name: streamGroup("alice") },
      { sgid: "2", name: streamGroup("bob") },
    ],
    [{ nickname: "alice", databaseId: "42" }],
  );

  await run(broadcastBox, ts);

  expect(removed).toEqual(["7"]);
  expect(deleted).toEqual([streamGroup("bob")]);
  expect(added).toEqual([]);
  expect(created).toEqual([]);
});

test("no streams: clears the shared group + stream groups and skips the client fetch", async () => {
  const broadcastBox = { fetchLiveStreamKeys: async () => new Set<string>() };
  const { ts, removed, deleted, clientFetches } = makeTeamspeak(
    ["42"],
    [{ sgid: "1", name: streamGroup("alice") }],
    [],
  );

  await run(broadcastBox, ts);

  expect(removed).toEqual(["42"]);
  expect(deleted).toEqual([streamGroup("alice")]);
  expect(clientFetches()).toBe(0);
});

test("live stream with no matching TeamSpeak user changes nothing", async () => {
  const broadcastBox = { fetchLiveStreamKeys: async () => new Set(["ghost"]) };
  const { ts, added, created, removed, deleted } = makeTeamspeak(
    [],
    [],
    [{ nickname: "someoneelse", databaseId: "9" }],
  );

  await run(broadcastBox, ts);

  expect(added).toEqual([]);
  expect(created).toEqual([]);
  expect(removed).toEqual([]);
  expect(deleted).toEqual([]);
});
