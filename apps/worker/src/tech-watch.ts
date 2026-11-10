import { agencyContext, type DbHandle } from "@sbos/db";
import { dueTechSources, recordDetectedUpdates, type DetectedItem } from "@sbos/core";
import { maskSecrets } from "@sbos/connectors";
import type { WorkerEnv } from "./env";
import { log } from "./log";
import { fixtureItems, githubApiUrl, parseGithubReleases, parseJsonFeed, parseRss } from "./tech-watch-parsers";

/**
 * Tech Watch (spec 4D): on a schedule, fetch every approved, due source and record new items as `tech_updates`
 * in state `detected`. Only approved sources are contacted, only over HTTPS, with a short timeout. With
 * SBOS_TECH_WATCH_OFFLINE=1 (sandbox, CI) a fixture item is recorded instead and the run is labelled `fixture`.
 * Detection never assesses, approves or applies anything.
 */
export async function runTechWatch(handle: DbHandle, env: WorkerEnv, deps: { fetch?: typeof globalThis.fetch; now?: () => Date } = {}): Promise<{ sources: number; newUpdates: number; failed: number }> {
  const now = deps.now ?? (() => new Date());
  const doFetch = deps.fetch ?? globalThis.fetch;
  const ctx = agencyContext({ tenantId: null, actorType: "system", actorId: "worker:tech-watch", roles: ["system"] });
  const due = await handle.withContext(ctx, (tx) => dueTechSources(tx, ctx, now()));
  let newUpdates = 0;
  let failed = 0;
  for (const s of due) {
    let items: DetectedItem[] = [];
    let mode: "live" | "fixture" = env.techWatchOffline ? "fixture" : "live";
    let status: "succeeded" | "failed" | "skipped" = "succeeded";
    let errorMessage: string | null = null;
    try {
      if (env.techWatchOffline) {
        items = fixtureItems(s.key, s.name, s.url, now());
      } else if (s.fetchKind === "github_releases") {
        const api = githubApiUrl(s.url);
        if (!api) throw new Error("source url is not a GitHub repository url");
        const res = await doFetch(api, { headers: { accept: "application/vnd.github+json", "user-agent": "sbos-tech-watch" }, signal: AbortSignal.timeout(15_000) });
        if (!res.ok) throw new Error(`GitHub responded ${res.status}`);
        items = parseGithubReleases(await res.json(), s.name);
      } else if (s.fetchKind === "rss") {
        const res = await doFetch(s.url, { headers: { accept: "application/rss+xml, application/atom+xml, application/xml", "user-agent": "sbos-tech-watch" }, signal: AbortSignal.timeout(15_000) });
        if (!res.ok) throw new Error(`source responded ${res.status}`);
        items = parseRss(await res.text(), s.name);
      } else if (s.fetchKind === "json") {
        const res = await doFetch(s.url, { headers: { accept: "application/json", "user-agent": "sbos-tech-watch" }, signal: AbortSignal.timeout(15_000) });
        if (!res.ok) throw new Error(`source responded ${res.status}`);
        items = parseJsonFeed(await res.json(), s.name);
      } else {
        status = "skipped";
      }
    } catch (err) {
      status = "failed";
      failed++;
      errorMessage = maskSecrets((err as Error).message ?? String(err));
      mode = env.techWatchOffline ? "fixture" : "live";
    }
    const r = await handle.withContext(ctx, (tx) => recordDetectedUpdates(tx, ctx, { sourceId: s.id, items, mode, status, errorMessage }));
    newUpdates += r.newUpdates;
    log(status === "failed" ? "warn" : "info", "tech watch source checked", { source: s.key, mode, status, items: items.length, newUpdates: r.newUpdates, error: errorMessage });
  }
  return { sources: due.length, newUpdates, failed };
}
