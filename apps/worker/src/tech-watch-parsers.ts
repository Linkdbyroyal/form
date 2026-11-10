import type { DetectedItem } from "@sbos/core";

/** Pure parsers for approved technology sources (spec 4D). Everything stored is metadata and the vendor's own summary text, trimmed. */

export function githubApiUrl(sourceUrl: string): string | null {
  const m = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\/releases)?\/?$/.exec(sourceUrl);
  return m ? `https://api.github.com/repos/${m[1]}/${m[2]}/releases?per_page=10` : null;
}

export function parseGithubReleases(json: unknown, subject: string): DetectedItem[] {
  if (!Array.isArray(json)) return [];
  const out: DetectedItem[] = [];
  for (const r of json as Array<Record<string, unknown>>) {
    const tag = typeof r.tag_name === "string" ? r.tag_name : null;
    const url = typeof r.html_url === "string" ? r.html_url : null;
    const published = typeof r.published_at === "string" ? new Date(r.published_at) : null;
    if (!tag || !url || !published || Number.isNaN(published.getTime())) continue;
    if (r.draft === true) continue;
    out.push({ externalId: `release:${tag}`, subject, proposedVersion: tag.replace(/^v/, ""), sourceUrl: url, publishedAt: published, summary: typeof r.body === "string" ? r.body.slice(0, 4000) : "", raw: { prerelease: r.prerelease === true, name: typeof r.name === "string" ? r.name : null } });
  }
  return out;
}

/** Minimal RSS/Atom parsing without a dependency: item title, link and date. */
export function parseRss(xml: string, subject: string): DetectedItem[] {
  const out: DetectedItem[] = [];
  const items = xml.match(/<(item|entry)\b[\s\S]*?<\/\1>/g) ?? [];
  for (const item of items.slice(0, 20)) {
    const title = text(item, "title");
    const link = text(item, "link") || attr(item, "link", "href");
    const date = text(item, "pubDate") || text(item, "updated") || text(item, "published");
    const published = date ? new Date(date) : null;
    if (!title || !link || !published || Number.isNaN(published.getTime())) continue;
    const version = /v?(\d+\.\d+(?:\.\d+)?)/.exec(title)?.[1] ?? published.toISOString().slice(0, 10);
    out.push({ externalId: link.slice(0, 300), subject, proposedVersion: version, sourceUrl: link.startsWith("https://") ? link : `https://${link.replace(/^https?:\/\//, "")}`, publishedAt: published, summary: (text(item, "description") || text(item, "summary") || "").replace(/<[^>]+>/g, "").slice(0, 4000) });
  }
  return out;
}

function text(block: string, tag: string): string {
  const m = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`).exec(block);
  return m?.[1] ? m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim() : "";
}
function attr(block: string, tag: string, name: string): string {
  const m = new RegExp(`<${tag}\\b[^>]*\\b${name}="([^"]+)"`).exec(block);
  return m?.[1] ?? "";
}

/** JSON feed: an array of { id, title, url, published_at, version?, summary? }. */
export function parseJsonFeed(json: unknown, subject: string): DetectedItem[] {
  if (!Array.isArray(json)) return [];
  const out: DetectedItem[] = [];
  for (const r of json as Array<Record<string, unknown>>) {
    const id = typeof r.id === "string" ? r.id : typeof r.url === "string" ? r.url : null;
    const url = typeof r.url === "string" ? r.url : null;
    const published = typeof r.published_at === "string" ? new Date(r.published_at) : null;
    if (!id || !url || !published || Number.isNaN(published.getTime()) || !url.startsWith("https://")) continue;
    out.push({ externalId: id.slice(0, 300), subject: typeof r.title === "string" ? r.title.slice(0, 200) : subject, proposedVersion: typeof r.version === "string" ? r.version : published.toISOString().slice(0, 10), sourceUrl: url, publishedAt: published, summary: typeof r.summary === "string" ? r.summary.slice(0, 4000) : "" });
  }
  return out;
}

/** Offline fixture: one synthetic item per source so the Tech Watch pipeline can be exercised without network. */
export function fixtureItems(sourceKey: string, subject: string, sourceUrl: string, now: Date): DetectedItem[] {
  return [{ externalId: `fixture:${sourceKey}:${now.toISOString().slice(0, 10)}`, subject, proposedVersion: `fixture-${now.toISOString().slice(0, 10)}`, sourceUrl, publishedAt: now, summary: "Synthetic fixture item (SBOS_TECH_WATCH_OFFLINE=1): no external source was contacted.", raw: { fixture: true } }];
}
