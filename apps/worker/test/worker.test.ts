import { describe, expect, it } from "vitest";
import { toBossSendOptions } from "@sbos/core";
import { RunFailure } from "@sbos/core";
import { classify } from "../src/executor";
import { nextRun } from "../src/schedules";

describe("schedule cron parsing", () => {
  it("computes the next run in the schedule's timezone", () => {
    const from = new Date("2026-11-09T06:30:00Z");
    const next = nextRun("0 7 * * 1-5", "UTC", from);
    expect(next?.toISOString()).toBe("2026-11-09T07:00:00.000Z");
    const nextCuracao = nextRun("0 7 * * 1-5", "America/Curacao", from);
    expect(nextCuracao?.toISOString()).toBe("2026-11-09T11:00:00.000Z");
  });

  it("returns null for an invalid cron expression", () => {
    expect(nextRun("not a cron", "UTC")).toBeNull();
  });
});

describe("pg-boss send options", () => {
  it("never passes undefined option values (pg-boss asserts on them)", () => {
    const opts = toBossSendOptions("agent.run", { singletonKey: "run:1" }) as unknown as Record<string, unknown>;
    expect(Object.values(opts).some((v) => v === undefined)).toBe(false);
    expect(opts.singletonKey).toBe("run:1");
    expect(opts.deadLetter).toBe("dead-letter");
    expect(opts.retryLimit).toBe(3);
  });
});

describe("failure classification", () => {
  it("maps provider and policy errors to the right class", () => {
    expect(classify(new Error("401 invalid x-api-key"))).toBe("credential");
    expect(classify(new Error("429 rate limited"))).toBe("model");
    expect(classify(new Error('tool "payments.write" is not allowed'))).toBe("policy");
    expect(classify(new Error("something unexpected"))).toBe("bug");
    expect(new RunFailure("model", "overloaded").retryable).toBe(true);
    expect(new RunFailure("budget", "cap").retryable).toBe(false);
  });
});

describe("tech watch parsers (spec 4D)", async () => {
  const { githubApiUrl, parseGithubReleases, parseJsonFeed, parseRss, fixtureItems } = await import("../src/tech-watch-parsers");
  it("maps a GitHub repository url to the releases API and parses releases, skipping drafts and malformed entries", () => {
    expect(githubApiUrl("https://github.com/timgit/pg-boss/releases")).toBe("https://api.github.com/repos/timgit/pg-boss/releases?per_page=10");
    expect(githubApiUrl("https://github.com/timgit/pg-boss")).toBe("https://api.github.com/repos/timgit/pg-boss/releases?per_page=10");
    expect(githubApiUrl("https://example.com/releases")).toBeNull();
    const items = parseGithubReleases([
      { tag_name: "v12.39.0", html_url: "https://github.com/timgit/pg-boss/releases/tag/v12.39.0", published_at: "2026-11-01T00:00:00Z", body: "notes", prerelease: false },
      { tag_name: "v13.0.0-beta", html_url: "https://github.com/timgit/pg-boss/releases/tag/v13.0.0-beta", published_at: "2026-11-05T00:00:00Z", draft: true },
      { html_url: "https://github.com/x", published_at: "2026-11-05T00:00:00Z" }
    ], "pg-boss");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ externalId: "release:v12.39.0", proposedVersion: "12.39.0", subject: "pg-boss" });
  });
  it("parses RSS and JSON feeds into items with https links only", () => {
    const rss = `<rss><channel><item><title><![CDATA[Release 2.3.1]]></title><link>https://example.com/changelog/2.3.1</link><pubDate>Mon, 02 Nov 2026 10:00:00 GMT</pubDate><description><p>Fixes</p></description></item><item><title>No date</title><link>https://example.com/x</link></item></channel></rss>`;
    const items = parseRss(rss, "Example");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ proposedVersion: "2.3.1", sourceUrl: "https://example.com/changelog/2.3.1", summary: "Fixes" });
    const json = parseJsonFeed([{ id: "a", title: "Advisory", url: "https://example.com/a", published_at: "2026-11-03T00:00:00Z" }, { id: "b", url: "http://insecure.example.com", published_at: "2026-11-03T00:00:00Z" }], "Advisories");
    expect(json).toHaveLength(1);
    expect(fixtureItems("k", "n", "https://example.com", new Date("2026-11-10T00:00:00Z"))[0]!.raw).toEqual({ fixture: true });
  });
});
