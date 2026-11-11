import pg from "pg";
import { requireEnv } from "../env";
import { parseNotification, type LiveNotification } from "./helpers";

/**
 * Process-wide PostgreSQL LISTEN client for the live stream (ADR-024). One dedicated `pg.Client` per web process
 * (not the pooled RLS connection) listens on channel `sbos_live`, decodes the identifier-only payload written by
 * `notify_live_change()` and fans it out to in-process subscribers. Subscribers never receive row content:
 * they re-read through `withContext()` so RLS and column grants decide what the operator sees.
 *
 * The client reconnects with exponential backoff on error or end. It is cached on globalThis because Next.js may
 * evaluate modules more than once; the connection is opened lazily on the first subscriber and closed when the
 * last one leaves.
 */
type Subscriber = (n: LiveNotification) => void;

interface LiveListener {
  subscribers: Set<Subscriber>;
  client: pg.Client | null;
  connecting: boolean;
  attempt: number;
  timer: NodeJS.Timeout | null;
  generation: number;
}

const globalForLive = globalThis as unknown as { __sbosLive?: LiveListener };

function listener(): LiveListener {
  if (!globalForLive.__sbosLive) {
    globalForLive.__sbosLive = { subscribers: new Set(), client: null, connecting: false, attempt: 0, timer: null, generation: 0 };
  }
  return globalForLive.__sbosLive;
}

const CHANNEL = "sbos_live";
const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 30_000;

function log(message: string): void {
  if (process.env.NODE_ENV !== "test") console.warn(`[live-stream] ${message}`);
}

async function connect(): Promise<void> {
  const l = listener();
  if (l.client || l.connecting || l.subscribers.size === 0) return;
  l.connecting = true;
  const generation = ++l.generation;
  const client = new pg.Client({ connectionString: requireEnv("DATABASE_URL"), application_name: "sbos-web-live" });
  const dropAndRetry = (why: string) => {
    if (l.generation !== generation) return;
    l.client = null;
    l.connecting = false;
    client.removeAllListeners();
    client.end().catch(() => undefined);
    if (l.subscribers.size === 0) return;
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** Math.min(l.attempt, 8));
    l.attempt += 1;
    log(`${why}; reconnecting in ${delay} ms`);
    l.timer = setTimeout(() => {
      l.timer = null;
      void connect();
    }, delay);
  };
  client.on("error", (err) => dropAndRetry(`connection error: ${err.message}`));
  client.on("end", () => dropAndRetry("connection ended"));
  client.on("notification", (msg) => {
    if (msg.channel !== CHANNEL || !msg.payload) return;
    const n = parseNotification(msg.payload);
    if (!n) return;
    for (const fn of l.subscribers) {
      try {
        fn(n);
      } catch (err) {
        log(`subscriber threw: ${(err as Error).message}`);
      }
    }
  });
  try {
    await client.connect();
    await client.query(`LISTEN ${CHANNEL}`);
    if (l.generation !== generation) {
      client.end().catch(() => undefined);
      return;
    }
    l.client = client;
    l.connecting = false;
    l.attempt = 0;
  } catch (err) {
    dropAndRetry(`connect failed: ${(err as Error).message}`);
  }
}

function disconnectIfIdle(): void {
  const l = listener();
  if (l.subscribers.size > 0) return;
  if (l.timer) {
    clearTimeout(l.timer);
    l.timer = null;
  }
  l.generation += 1;
  const c = l.client;
  l.client = null;
  l.connecting = false;
  l.attempt = 0;
  if (c) {
    c.removeAllListeners();
    c.end().catch(() => undefined);
  }
}

/**
 * Subscribes to live notifications. Opens the LISTEN connection on the first subscriber; returns an unsubscribe
 * function that closes it again when nobody listens any more.
 */
export function subscribeLive(fn: Subscriber): () => void {
  const l = listener();
  l.subscribers.add(fn);
  void connect();
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    l.subscribers.delete(fn);
    disconnectIfIdle();
  };
}

/** Diagnostic for the stream route: true while the LISTEN connection is up. */
export function liveListenerConnected(): boolean {
  return listener().client !== null;
}
