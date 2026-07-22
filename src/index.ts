import { BroadcastBoxClient } from "./broadcast-box.ts";
import { config } from "./config.ts";
import { logger } from "./logger.ts";
import { TeamSpeakManager } from "./teamspeak.ts";
import { TwitchWatcher } from "./twitch-watcher.ts";
import { TwitchClient } from "./twitch.ts";
import { Watcher } from "./watcher.ts";

/** A named unit of work run each poll and torn down on shutdown. */
interface NamedWatcher {
  name: string;
  reconcile: (signal: AbortSignal) => Promise<void>;
  cleanup: () => Promise<void>;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

async function main(): Promise<void> {
  logger.info("Starting teamspeak-stream-live");
  logger.debug(
    `Features — Broadcast Box: ${config.broadcastBox ? "enabled" : "disabled"} · ` +
      `Twitch: ${config.twitch ? "enabled" : "disabled"} · poll: ${config.pollIntervalMs}ms`,
  );

  const teamspeak = await TeamSpeakManager.connect(config.teamspeak);
  const watchers: NamedWatcher[] = [];

  if (config.broadcastBox) {
    const broadcastBox = new BroadcastBoxClient(config.broadcastBox);
    const liveGroupSgid = await teamspeak.ensureLiveGroup(config.broadcastBox.liveGroupName);
    const watcher = new Watcher(broadcastBox, teamspeak, liveGroupSgid, config.broadcastBox);
    watchers.push({
      name: "Broadcast Box",
      reconcile: (signal) => watcher.reconcile(signal),
      cleanup: () => watcher.cleanup(),
    });
  }

  if (config.twitch) {
    const twitch = new TwitchClient(config.twitch);
    const liveGroupSgid = await teamspeak.ensureLiveGroup(config.twitch.liveGroupName);
    const watcher = new TwitchWatcher(twitch, teamspeak, liveGroupSgid, config.twitch);
    watchers.push({
      name: "Twitch",
      reconcile: (signal) => watcher.reconcile(signal),
      cleanup: () => watcher.cleanup(),
    });
  }

  const abort = new AbortController();
  let shuttingDown = false;

  const shutdown = (reason: string): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info(`Received ${reason}, shutting down…`);
    abort.abort();
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // Run each watcher in isolation so one feature's failure doesn't skip the
  // other; both self-heal on the next poll.
  const reconcileSafely = async (watcher: NamedWatcher): Promise<void> => {
    try {
      await watcher.reconcile(abort.signal);
    } catch (error) {
      if (!abort.signal.aborted) {
        logger.error(
          `${watcher.name} reconcile cycle failed:`,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  };

  while (!abort.signal.aborted) {
    for (const watcher of watchers) {
      await reconcileSafely(watcher);
    }

    await delay(config.pollIntervalMs, abort.signal);
  }

  // Best-effort cleanup: clear the live groups and delete per-user stream groups.
  for (const watcher of watchers) {
    try {
      await watcher.cleanup();
    } catch (error) {
      logger.error(
        `${watcher.name} cleanup during shutdown failed:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  await teamspeak.disconnect().catch(() => undefined);
  logger.info("Shutdown complete");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
