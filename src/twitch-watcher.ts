import { logger } from "./logger.ts";
import type { TeamSpeakManager } from "./teamspeak.ts";
import type { TwitchClient } from "./twitch.ts";

/**
 * Reconciles a shared "live" group against the Twitch channels currently live.
 *
 * The direction is the reverse of the Broadcast Box watcher: the users to check
 * are discovered from pre-assigned `twitch.tv/<username>` server groups (created
 * by admins, never by this service). Each poll every such username is checked on
 * Twitch, and the members of the live ones get the shared live group (`🟣`),
 * shown before their nickname in the tree.
 *
 * Membership is keyed by database id, so it applies to offline members too (the
 * prefix simply renders once they connect). The go-live announcement, however,
 * only fires for currently-connected members.
 *
 * Like the Broadcast Box watcher, this keeps no in-memory state — each poll
 * diffs the desired state against what actually exists on the server.
 */
export class TwitchWatcher {
  readonly #twitch: TwitchClient;
  readonly #teamspeak: TeamSpeakManager;
  readonly #liveGroupSgid: string;
  readonly #twitchGroupPrefix: string;
  readonly #publicTwitchHost: string;
  readonly #liveMessageTemplate: string;

  constructor(
    twitch: TwitchClient,
    teamspeak: TeamSpeakManager,
    liveGroupSgid: string,
    options: { twitchGroupPrefix: string; publicTwitchHost: string; liveMessageTemplate: string },
  ) {
    this.#twitch = twitch;
    this.#teamspeak = teamspeak;
    this.#liveGroupSgid = liveGroupSgid;
    this.#twitchGroupPrefix = options.twitchGroupPrefix;
    this.#publicTwitchHost = options.publicTwitchHost;
    this.#liveMessageTemplate = options.liveMessageTemplate;
  }

  /** Runs a single reconciliation cycle. */
  async reconcile(signal?: AbortSignal): Promise<void> {
    const groups = await this.#teamspeak.listTwitchGroups(this.#twitchGroupPrefix);
    const currentMembers = await this.#teamspeak.listGroupMemberDbids(this.#liveGroupSgid);

    // No twitch.tv/ groups exist: clear the shared group and skip Twitch entirely.
    if (groups.length === 0) {
      await this.#removeMembers(currentMembers);

      return;
    }

    const usernames = [...new Set(groups.map((group) => group.username))];
    const liveUsernames = await this.#twitch.fetchLiveUsernames(usernames, signal);

    // Desired live-group members mapped to the twitch username they're live as
    // (used to build the announcement link).
    const desired = new Map<string, string>();
    for (const group of groups) {
      if (!liveUsernames.has(group.username)) {
        continue;
      }
      for (const databaseId of group.members) {
        desired.set(databaseId, group.username);
      }
    }

    await this.#reconcileMembership(currentMembers, desired);
  }

  /** Best-effort teardown for shutdown: empty the shared group. */
  async cleanup(): Promise<void> {
    const members = await this.#teamspeak.listGroupMemberDbids(this.#liveGroupSgid);
    await this.#removeMembers(members);
  }

  async #reconcileMembership(current: Set<string>, desired: Map<string, string>): Promise<void> {
    const newlyLive = new Map<string, string>();
    for (const [databaseId, username] of desired) {
      if (current.has(databaseId)) {
        continue;
      }

      try {
        await this.#teamspeak.addClientToGroup(databaseId, this.#liveGroupSgid);
        logger.info(`Added dbid=${databaseId} to the Twitch live group`);
        newlyLive.set(databaseId, username);
      } catch (error) {
        logger.error(`Failed to add dbid=${databaseId} to the Twitch live group:`, message(error));
      }
    }

    await this.#announce(newlyLive);

    for (const databaseId of current) {
      if (desired.has(databaseId)) {
        continue;
      }

      try {
        await this.#teamspeak.removeClientFromGroup(databaseId, this.#liveGroupSgid);
        logger.info(`Removed dbid=${databaseId} from the Twitch live group`);
      } catch (error) {
        logger.error(
          `Failed to remove dbid=${databaseId} from the Twitch live group:`,
          message(error),
        );
      }
    }
  }

  /** Public Twitch URL for a channel, e.g. `https://twitch.tv/alice`. */
  #streamLink(username: string): string {
    return `https://${this.#publicTwitchHost}/${username}`;
  }

  /**
   * Best-effort go-live announcement for the newly-live members that are
   * currently connected. Offline members get no message — their live prefix
   * renders when they connect. Fires once per go-live because it is derived from
   * the shared-group membership transition.
   */
  async #announce(newlyLive: Map<string, string>): Promise<void> {
    if (this.#liveMessageTemplate === "" || newlyLive.size === 0) {
      return;
    }

    const clients = await this.#teamspeak.listClients();
    const clientByDbid = new Map(clients.map((client) => [client.databaseId, client]));

    // Announce one after another: a TeamSpeak channel message goes to the query
    // client's current channel, so it hops into each user's channel in turn.
    for (const [databaseId, username] of newlyLive) {
      const client = clientByDbid.get(databaseId);
      if (client === undefined) {
        continue;
      }

      const text = this.#liveMessageTemplate
        .replaceAll("{nickname}", client.nickname)
        .replaceAll("{link}", this.#streamLink(username));

      try {
        await this.#teamspeak.sendChannelMessage(client.channelId, text);
        logger.info(`Announced "${client.nickname}" live on Twitch in channel ${client.channelId}`);
      } catch (error) {
        logger.error(`Failed to announce "${client.nickname}" as live on Twitch:`, message(error));
      }
    }
  }

  async #removeMembers(databaseIds: Set<string>): Promise<void> {
    for (const databaseId of databaseIds) {
      try {
        await this.#teamspeak.removeClientFromGroup(databaseId, this.#liveGroupSgid);
      } catch (error) {
        logger.error(
          `Failed to remove dbid=${databaseId} from the Twitch live group:`,
          message(error),
        );
      }
    }
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
