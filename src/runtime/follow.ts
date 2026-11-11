// SPDX-License-Identifier: Apache-2.0
import type { StreamEvent, StreamResponse } from "../api/client.js";
import { ExitCode, RemoteError } from "../exit.js";
import type { ServiceDependencies } from "./service.js";

/**
 * A stream that closes this soon after opening without a frame did not expire:
 * it was refused or dropped. Three in a row stop the follow.
 */
const ABRUPT_CLOSE_MS = 5_000;
const MAX_ABRUPT_CLOSES = 3;
/** Ids remembered across reconnects; the engine replays its last 100 events on connect. */
const REMEMBERED_IDS = 1_000;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The `id` of an activity frame, when it carries one; a named signal (`persisted`) does not. */
function frameId(event: StreamEvent): string | undefined {
  if (event.event !== undefined) return undefined;
  try {
    const id = (JSON.parse(event.data) as { id?: unknown } | null)?.id;
    return typeof id === "string" ? id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Follows an activity stream across the ends the engine imposes on it.
 *
 * From engine 1.3.6 an activity stream ends after 15 minutes, and a client that
 * falls 200 frames behind has it ended at once; the panel's EventSource just
 * reconnects. So does this: an end before `limit` frames opens the stream again
 * and says so on stderr. On connect the engine replays its recent events, so a
 * frame whose `id` was already printed is skipped — the follow neither repeats
 * an event nor, beyond the replay window, recovers one emitted while it was
 * reconnecting.
 *
 * Returns once `limit` frames were handed to `onFrame`. A stream that keeps
 * closing as soon as it opens is a refusal, not an expiry, and ends the follow
 * with a remote failure instead of a reconnect loop.
 */
export async function followStream(
  deps: ServiceDependencies,
  open: () => Promise<StreamResponse>,
  onFrame: (event: StreamEvent) => void,
  limit: number,
  label: string,
): Promise<void> {
  const sleep = deps.sleep ?? defaultSleep;
  const seen = new Set<string>();
  let delivered = 0;
  let abrupt = 0;
  for (;;) {
    const opened = Date.now();
    const stream = await open();
    let received = 0;
    for await (const event of stream.events) {
      received += 1;
      const id = frameId(event);
      if (id !== undefined) {
        if (seen.has(id)) continue;
        seen.add(id);
        if (seen.size > REMEMBERED_IDS) seen.delete(seen.values().next().value as string);
      }
      onFrame(event);
      delivered += 1;
      if (delivered >= limit) return;
    }
    if (received === 0 && Date.now() - opened < ABRUPT_CLOSE_MS) {
      abrupt += 1;
      if (abrupt >= MAX_ABRUPT_CLOSES) {
        throw new RemoteError(
          `The ${label} closed ${MAX_ABRUPT_CLOSES} times right after opening; stopped following.`,
          ExitCode.Remote,
        );
      }
      await sleep(1_000 * abrupt);
    } else {
      abrupt = 0;
    }
    deps.io.stderr(`note: the engine closed the ${label}; reconnected. Events already printed are not repeated.\n`);
  }
}
