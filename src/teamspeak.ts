import { QueryProtocol, TeamSpeak, TextMessageTargetMode } from "ts3-nodejs-library";
import { logger } from "./logger.ts";

/** A regular (non-template) server group. */
const SERVER_GROUP_TYPE_REGULAR = 1;

/** `i_group_show_name_in_tree` value that renders the group name before the nickname. */
const SHOW_NAME_IN_TREE_BEFORE = 1;

/** TeamSpeak error id returned when a query yields an empty result set. */
const EMPTY_RESULT_ERROR_ID = "1281";

export interface TeamSpeakClientInfo {
  nickname: string;
  databaseId: string;
  /** Id of the channel the client is currently in. */
  channelId: string;
}

export interface ServerGroupRef {
  sgid: string;
  name: string;
}

/** A `twitch.tv/<username>` server group resolved to its username and members. */
export interface TwitchGroupRef {
  sgid: string;
  name: string;
  /** The group name after the prefix, lowercased (e.g. `alice`). */
  username: string;
  /** Database ids of the clients assigned to this group. */
  members: Set<string>;
}

function isEmptyResultError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "id" in error &&
    (error as { id: unknown }).id === EMPTY_RESULT_ERROR_ID
  );
}

/**
 * Thin wrapper around a TeamSpeak ServerQuery connection exposing only the
 * operations the watcher needs, plus transparent reconnection.
 */
export class TeamSpeakManager {
  #query: TeamSpeak;

  private constructor(query: TeamSpeak) {
    this.#query = query;
  }

  static async connect(options: {
    host: string;
    queryPort: number;
    serverPort: number;
    username: string;
    password: string;
    nickname: string;
  }): Promise<TeamSpeakManager> {
    const query = await TeamSpeak.connect({
      host: options.host,
      protocol: QueryProtocol.RAW,
      queryport: options.queryPort,
      serverport: options.serverPort,
      username: options.username,
      password: options.password,
      nickname: options.nickname,
    });

    const manager = new TeamSpeakManager(query);
    manager.#attachHandlers();
    logger.info(`Connected to TeamSpeak ServerQuery at ${options.host}:${options.queryPort}`);

    return manager;
  }

  #attachHandlers(): void {
    this.#query.on("error", (error) => {
      logger.error("TeamSpeak connection error:", error.message);
    });
    this.#query.on("close", (error) => {
      logger.warn(`TeamSpeak connection closed${error ? `: ${error.message}` : ""}. Reconnecting…`);
      // Reconnect forever; the library restores the selected virtual server
      // and re-registers context on success.
      this.#query.reconnect(-1, 2000).then(
        () => logger.info("Reconnected to TeamSpeak ServerQuery"),
        (reason: unknown) => logger.error("TeamSpeak reconnect failed:", reason),
      );
    });
  }

  /**
   * Finds or creates the shared "live" group and makes sure its name is shown
   * before the nickname in the client tree. Returns its server group id.
   */
  async ensureLiveGroup(name: string): Promise<string> {
    const groups = await this.#query.serverGroupList();
    let group = groups.find((candidate) => candidate.name === name);

    if (group === undefined) {
      group = await this.#query.serverGroupCreate(name, SERVER_GROUP_TYPE_REGULAR);
      logger.info(`Created shared live group "${name}" (sgid=${group.sgid})`);
    }

    await this.#query.serverGroupAddPerm(group.sgid, {
      permname: "i_group_show_name_in_tree",
      permvalue: SHOW_NAME_IN_TREE_BEFORE,
    });

    return group.sgid;
  }

  /** Lists regular (non-query) connected clients. */
  async listClients(): Promise<TeamSpeakClientInfo[]> {
    const clients = await this.#query.clientList({ clientType: 0 });

    return clients.map((client) => ({
      nickname: client.nickname,
      databaseId: client.databaseId,
      channelId: client.cid,
    }));
  }

  /**
   * Sends a text message to a channel. TeamSpeak channel messages always go to
   * the query client's *current* channel, so the client is moved into the
   * target channel first (unless it is already there).
   */
  async sendChannelMessage(channelId: string, text: string): Promise<void> {
    const whoami = await this.#query.whoami();

    if (whoami.clientChannelId !== channelId) {
      await this.#query.clientMove(whoami.clientId, channelId);
    }

    await this.#query.sendTextMessage(channelId, TextMessageTargetMode.CHANNEL, text);
  }

  /** Database ids of the clients currently in the given server group. */
  async listGroupMemberDbids(sgid: string): Promise<Set<string>> {
    try {
      const members = await this.#query.serverGroupClientList(sgid);

      return new Set(members.map((member) => member.cldbid));
    } catch (error) {
      if (isEmptyResultError(error)) {
        return new Set();
      }

      throw error;
    }
  }

  /** Server groups whose name starts with `prefix`, excluding `excludeSgid`. */
  async listGroupsByPrefix(prefix: string, excludeSgid: string): Promise<ServerGroupRef[]> {
    const groups = await this.#query.serverGroupList();

    return groups
      .filter((group) => group.sgid !== excludeSgid && group.name.startsWith(prefix))
      .map((group) => ({ sgid: group.sgid, name: group.name }));
  }

  /**
   * Pre-assigned `twitch.tv/<username>` groups, each resolved to its twitch
   * username and current member database ids. Groups with an empty username
   * (a bare prefix) are skipped.
   */
  async listTwitchGroups(prefix: string): Promise<TwitchGroupRef[]> {
    const groups = await this.#query.serverGroupList();
    const matching = groups.filter((group) => group.name.startsWith(prefix));

    const result: TwitchGroupRef[] = [];
    for (const group of matching) {
      const username = group.name.slice(prefix.length).trim().toLowerCase();

      if (username === "") {
        continue;
      }

      const members = await this.listGroupMemberDbids(group.sgid);
      result.push({ sgid: group.sgid, name: group.name, username, members });
    }

    return result;
  }

  async addClientToGroup(databaseId: string, sgid: string): Promise<void> {
    await this.#query.serverGroupAddClient(databaseId, sgid);
  }

  async removeClientFromGroup(databaseId: string, sgid: string): Promise<void> {
    await this.#query.serverGroupDelClient(databaseId, sgid);
  }

  /** Creates a regular server group and assigns the given client to it. */
  async createGroupAndAssign(name: string, databaseId: string): Promise<string> {
    const group = await this.#query.serverGroupCreate(name, SERVER_GROUP_TYPE_REGULAR);
    await this.#query.serverGroupAddClient(databaseId, group.sgid);
    logger.info(`Created group "${name}" and assigned client dbid=${databaseId}`);

    return group.sgid;
  }

  /** Deletes a server group (force-removing any members). */
  async deleteGroup(group: ServerGroupRef): Promise<void> {
    await this.#query.serverGroupDel(group.sgid, true);
    logger.info(`Deleted group "${group.name}"`);
  }

  async disconnect(): Promise<void> {
    await this.#query.quit();
  }
}
