import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Env, poll } from "../src/index";

const xml = readFileSync(new URL("./fixtures/feed.xml", import.meta.url), "utf8");
const schema = ["0001_init.sql", "0002_sent_at.sql"]
  .map((f) => readFileSync(new URL(`../migrations/${f}`, import.meta.url), "utf8"))
  .join("\n");

// Just enough of the D1 API, backed by an in-memory SQLite.
function fakeD1(): D1Database {
  const db = new DatabaseSync(":memory:");
  db.exec(schema);
  // Like D1, bind() returns a new statement, so batched statements keep their own params.
  const statement = (sql: string, params: unknown[] = []) => ({
    bind: (...args: unknown[]) => statement(sql, args),
    async run() {
      const r = db.prepare(sql).run(...(params as never[]));
      return { meta: { changes: Number(r.changes) } };
    },
    async all() {
      return { results: db.prepare(sql).all(...(params as never[])) };
    },
    async first(column?: string) {
      const row = db.prepare(sql).get(...(params as never[])) as Record<string, unknown> | undefined;
      if (!row) return null;
      return column ? row[column] : row;
    },
  });
  const prepare = (sql: string) => statement(sql);
  return {
    prepare,
    async batch(stmts: { run(): Promise<unknown> }[]) {
      return Promise.all(stmts.map((s) => s.run()));
    },
  } as unknown as D1Database;
}

function makeEnv(db = fakeD1()): Env {
  return {
    DB: db,
    TELEGRAM_BOT_TOKEN: "TOKEN",
    TELEGRAM_CHAT_ID: "42",
    FEED_URL: "https://44-label.group/shop?format=rss",
    BURST_MINUTES: "59,0,1,2",
    BURST_INTERVAL_SEC: "15",
    FAILURE_ALERT_THRESHOLD: "3",
  };
}

const NEW_ITEM = `<item>
<title>NEW ARTIST – 44031 12" VINYL [PRE-ORDER]</title>
<link>https://44-label.group/shop/new-44031</link>
<guid isPermaLink="false">a:b:new</guid>
<description>PRE-ORDER!</description>
<media:content url="https://images.squarespace-cdn.com/new.jpg" medium="image"></media:content>
</item>`;

let feed: string | Error;
let telegram: { method: string; body: Record<string, unknown> }[];
let telegramFails: boolean;

beforeEach(() => {
  feed = xml;
  telegram = [];
  telegramFails = false;
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://api.telegram.org/")) {
      telegram.push({ method: url.split("/").pop()!, body: JSON.parse(String(init?.body)) });
      return new Response("{}", { status: telegramFails ? 500 : 200 });
    }
    if (url.includes("format=rss")) {
      if (feed instanceof Error) throw feed;
      return new Response(feed);
    }
    return new Response(`<meta property="product:price:amount" content="28.00"><meta property="product:price:currency" content="EUR">`);
  });
});

afterEach(() => vi.unstubAllGlobals());

describe("poll", () => {
  it("seeds silently on the first run, then alerts only on new items", async () => {
    const env = makeEnv();
    await poll(env);
    expect(telegram.map((t) => t.method)).toEqual(["sendMessage"]);
    expect(telegram[0].body.text).toMatch(/Бот запущен/);

    telegram = [];
    await poll(env);
    expect(telegram).toEqual([]);

    feed = xml.replace("<item>", `${NEW_ITEM}<item>`);
    await poll(env);
    expect(telegram).toHaveLength(1);
    expect(telegram[0].method).toBe("sendPhoto");
    expect(telegram[0].body.photo).toBe("https://images.squarespace-cdn.com/new.jpg");
    expect(telegram[0].body.caption).toContain("28.00 €");

    telegram = [];
    await poll(env);
    expect(telegram).toEqual([]);
  });

  it("retries an item whose alert failed", async () => {
    const env = makeEnv();
    await poll(env);
    feed = xml.replace("<item>", `${NEW_ITEM}<item>`);

    telegramFails = true;
    await poll(env);

    telegramFails = false;
    telegram = [];
    await poll(env);
    expect(telegram.map((t) => t.method)).toEqual(["sendPhoto"]);
  });

  it("resends an alert whose run died after claiming it", async () => {
    const env = makeEnv();
    await poll(env);
    feed = xml.replace("<item>", `${NEW_ITEM}<item>`);

    // Simulate a run killed between claim and send.
    const claimedAt = new Date(Date.now() - 30_000).toISOString();
    await env.DB.prepare("INSERT INTO seen (guid, title, link, first_seen_at) VALUES (?, ?, ?, ?)")
      .bind("a:b:new", "NEW", "https://44-label.group/shop/new-44031", claimedAt)
      .run();

    telegram = [];
    await poll(env);
    expect(telegram).toEqual([]); // a fresh claim may still be in flight

    await env.DB.prepare("UPDATE seen SET first_seen_at = ? WHERE guid = ?")
      .bind(new Date(Date.now() - 5 * 60_000).toISOString(), "a:b:new")
      .run();
    await poll(env);
    expect(telegram.map((t) => t.method)).toEqual(["sendPhoto"]);

    telegram = [];
    await poll(env);
    expect(telegram).toEqual([]);
  });

  it("warns once after repeated feed failures and once on recovery", async () => {
    const env = makeEnv();
    await poll(env);
    telegram = [];

    feed = new Error("network down");
    for (let i = 0; i < 5; i++) await poll(env);
    expect(telegram).toHaveLength(1);
    expect(telegram[0].body.text).toMatch(/Не могу прочитать ленту/);

    feed = xml;
    await poll(env);
    await poll(env);
    expect(telegram).toHaveLength(2);
    expect(telegram[1].body.text).toMatch(/снова читается/);
  });

  it("treats an empty feed as a failure, not as an empty shop", async () => {
    const env = makeEnv();
    feed = "<rss><channel></channel></rss>";
    await poll(env);
    expect(telegram).toEqual([]);
  });
});
