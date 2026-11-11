import { getLiveSnapshot } from "@/lib/live/queries";
import { subscribeLive } from "@/lib/live/stream";
import { resolveOperatorContext } from "@/lib/request-context";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const DEBOUNCE_MS = 250;
const HEARTBEAT_MS = 25_000;

/**
 * Server-sent events for Live Mission Control (ADR-024). Gate: operator with MFA, otherwise 401 JSON (no redirect,
 * an EventSource cannot sign in). On connect the route sends `event: snapshot` with the full operator snapshot, then
 * for every PostgreSQL notification (identifiers only, see migration 0011) it debounces 250 ms and sends a fresh
 * snapshot read through `withContext()` in operator context: RLS and column grants decide what the stream carries,
 * the notification payload itself is never forwarded. Heartbeat comment every 25 s; everything is torn down when the
 * client aborts.
 */
export async function GET(request: Request): Promise<Response> {
  const ctx = await resolveOperatorContext();
  if (!ctx) return Response.json({ error: "operator session with MFA required" }, { status: 401 });

  const encoder = new TextEncoder();
  let closed = false;
  let debounce: NodeJS.Timeout | null = null;
  let heartbeat: NodeJS.Timeout | null = null;
  let unsubscribe: (() => void) | null = null;
  let sending = false;
  let pending = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          cleanup();
        }
      };
      const cleanup = () => {
        if (closed) return;
        closed = true;
        if (debounce) clearTimeout(debounce);
        if (heartbeat) clearInterval(heartbeat);
        unsubscribe?.();
        try {
          controller.close();
        } catch {
          // already closed by the client
        }
      };
      const sendSnapshot = async () => {
        if (closed) return;
        if (sending) {
          pending = true;
          return;
        }
        sending = true;
        try {
          const snapshot = await getLiveSnapshot(ctx);
          write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
        } catch (err) {
          write(`event: error\ndata: ${JSON.stringify({ message: (err as Error).message.slice(0, 200) })}\n\n`);
        } finally {
          sending = false;
          if (pending && !closed) {
            pending = false;
            schedule();
          }
        }
      };
      const schedule = () => {
        if (closed) return;
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => {
          debounce = null;
          void sendSnapshot();
        }, DEBOUNCE_MS);
      };

      request.signal.addEventListener("abort", cleanup);
      write(`retry: 3000\n: connected\n\n`);
      await sendSnapshot();
      unsubscribe = subscribeLive(() => schedule());
      heartbeat = setInterval(() => write(`: ping ${new Date().toISOString()}\n\n`), HEARTBEAT_MS);
    },
    cancel() {
      closed = true;
      if (debounce) clearTimeout(debounce);
      if (heartbeat) clearInterval(heartbeat);
      unsubscribe?.();
    }
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
      Connection: "keep-alive"
    }
  });
}
