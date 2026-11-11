"use client";

import { useEffect, useRef, useState } from "react";
import { backoffDelay, parseSnapshotEvent, type ConnectionState, type LiveSnapshot } from "./helpers";

const STREAM_URL = "/api/mission-control/stream";
const SNAPSHOT_URL = "/api/mission-control/snapshot";
const POLL_MS = 5_000;

export interface LiveState {
  snapshot: LiveSnapshot;
  connection: ConnectionState;
  connected: boolean;
  lastUpdate: string | null;
  /** Milliseconds until the next reconnect attempt, for the status strip; null while connected. */
  retryInMs: number | null;
}

/**
 * Opens the server-sent event stream and keeps the latest snapshot. On error the EventSource is closed and reopened
 * with exponential backoff plus jitter (1 s .. 30 s); while disconnected the hook polls the snapshot endpoint every
 * 5 s so the board never goes stale. The server sends full snapshots, so there is nothing to merge client side.
 */
export function useLiveSnapshot(initial: LiveSnapshot): LiveState {
  const [snapshot, setSnapshot] = useState<LiveSnapshot>(initial);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [lastUpdate, setLastUpdate] = useState<string | null>(initial.generatedAt);
  const [retryInMs, setRetryInMs] = useState<number | null>(null);
  const attempt = useRef(0);

  useEffect(() => {
    let source: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let disposed = false;

    const apply = (s: LiveSnapshot) => {
      if (disposed) return;
      setSnapshot(s);
      setLastUpdate(s.generatedAt);
    };

    const stopPolling = () => {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
    };
    const poll = async () => {
      try {
        const res = await fetch(SNAPSHOT_URL, { cache: "no-store", credentials: "same-origin" });
        if (!res.ok) return;
        const s = parseSnapshotEvent(await res.text());
        if (s) apply(s);
      } catch {
        // offline: the next tick tries again
      }
    };
    const startPolling = () => {
      if (pollTimer) return;
      setConnection("polling");
      void poll();
      pollTimer = setInterval(() => void poll(), POLL_MS);
    };

    const scheduleReconnect = () => {
      if (disposed || reconnectTimer) return;
      const delay = backoffDelay(attempt.current);
      attempt.current += 1;
      setRetryInMs(delay);
      setConnection(attempt.current <= 1 ? "reconnecting" : "polling");
      if (attempt.current > 1) startPolling();
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        open();
      }, delay);
    };

    const open = () => {
      if (disposed || typeof EventSource === "undefined") {
        startPolling();
        return;
      }
      source?.close();
      source = new EventSource(STREAM_URL, { withCredentials: true });
      source.addEventListener("open", () => {
        attempt.current = 0;
        setRetryInMs(null);
        setConnection("connected");
        stopPolling();
      });
      source.addEventListener("snapshot", (ev) => {
        const s = parseSnapshotEvent((ev as MessageEvent<string>).data);
        if (s) apply(s);
      });
      source.addEventListener("error", () => {
        // EventSource retries on its own for transient errors, but not after a 401 or a closed response: own the schedule.
        source?.close();
        source = null;
        scheduleReconnect();
      });
    };

    open();
    return () => {
      disposed = true;
      source?.close();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      stopPolling();
    };
  }, []);

  return { snapshot, connection, connected: connection === "connected", lastUpdate, retryInMs };
}
