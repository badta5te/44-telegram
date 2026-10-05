import { FeedItem, parseFeed } from "./feed";
import { fetchPrice, USER_AGENT } from "./price";
import { sendAlert, sendText } from "./telegram";

export interface Env {
  DB: D1Database;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string; // one id or several, comma-separated
  FEED_URL: string;
  BURST_MINUTES: string; // UTC minutes polled several times, e.g. "59,0,1,2"
  BURST_INTERVAL_SEC: string;
  FAILURE_ALERT_THRESHOLD: string;
}

export default {
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    const minute = new Date(controller.scheduledTime).getUTCMinutes();
    const burst = env.BURST_MINUTES.split(",").map(Number).includes(minute);

    if (!burst) {
      await poll(env);
      return;
    }

    // Drops go live exactly on the hour, so around :00 poll several times a minute.
    const interval = Number(env.BURST_INTERVAL_SEC) * 1000;
    const start = Date.now();
    for (let offset = 0; offset < 60_000; offset += interval) {
      const wait = start + offset - Date.now();
      if (wait > 0) await sleep(wait);
      await poll(env);
    }
  },

  async fetch(): Promise<Response> {
    return new Response("44-telegram is running\n");
  },
} satisfies ExportedHandler<Env>;

export async function poll(env: Env): Promise<void> {
  let items: FeedItem[];
  try {
    items = await fetchFeed(env.FEED_URL);
  } catch (err) {
    console.error("feed fetch failed", err);
    await recordFailure(env);
    return;
  }
  await recordSuccess(env);

  // One query for the whole feed instead of one per item keeps each run cheap.
  const known = await knownItems(env, items);
  if (known.size === 0 && (await isFirstRun(env))) {
    await seed(env, items);
    await broadcast(env, `Бот запущен. Слежу за ${env.FEED_URL}, уже в ленте: ${items.length}.`);
    return;
  }

  // Oldest first, so several new records arrive in release order.
  for (const item of [...items].reverse()) {
    const row = known.get(item.guid);
    if (row && !isStalePending(row)) continue;
    if (!(await claim(env, item, row))) continue;
    try {
      const price = await fetchPrice(item.link);
      for (const chatId of chatIds(env)) {
        await sendAlert(env.TELEGRAM_BOT_TOKEN, chatId, item, price);
      }
      await env.DB.prepare("UPDATE seen SET sent_at = ? WHERE guid = ?")
        .bind(new Date().toISOString(), item.guid)
        .run();
      console.log("alerted", item.guid, item.title);
    } catch (err) {
      // Release the claim so the next poll retries this item.
      console.error("alert failed", item.guid, err);
      await env.DB.prepare("DELETE FROM seen WHERE guid = ?").bind(item.guid).run();
    }
  }
}

interface SeenRow {
  guid: string;
  first_seen_at: string;
  sent_at: string | null;
}

// A run killed mid-alert (CPU limit, deploy, crash) leaves a claimed but unsent row.
// After this long we assume its run is dead and send the alert again.
const STALE_CLAIM_MS = 2 * 60_000;

function isStalePending(row: SeenRow): boolean {
  return row.sent_at === null && Date.now() - Date.parse(row.first_seen_at) > STALE_CLAIM_MS;
}

async function knownItems(env: Env, items: FeedItem[]): Promise<Map<string, SeenRow>> {
  const placeholders = items.map(() => "?").join(",");
  const { results } = await env.DB.prepare(
    `SELECT guid, first_seen_at, sent_at FROM seen WHERE guid IN (${placeholders})`,
  )
    .bind(...items.map((i) => i.guid))
    .all<SeenRow>();
  return new Map(results.map((r) => [r.guid, r]));
}

async function fetchFeed(url: string): Promise<FeedItem[]> {
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/rss+xml, application/xml" },
    cf: { cacheTtl: 0 },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`feed responded ${res.status}`);

  const items = parseFeed(await res.text());
  // An empty feed means a broken response, not a shop with no records.
  if (items.length === 0) throw new Error("feed has no items");
  return items;
}

// Both statements are atomic compare-and-set, so overlapping polls can't alert the same item twice.
async function claim(env: Env, item: FeedItem, stale?: SeenRow): Promise<boolean> {
  const now = new Date().toISOString();
  const stmt = stale
    ? env.DB.prepare(
        "UPDATE seen SET first_seen_at = ? WHERE guid = ? AND sent_at IS NULL AND first_seen_at = ?",
      ).bind(now, item.guid, stale.first_seen_at)
    : env.DB.prepare(
        "INSERT OR IGNORE INTO seen (guid, title, link, first_seen_at) VALUES (?, ?, ?, ?)",
      ).bind(item.guid, item.title, item.link, now);
  const result = await stmt.run();
  return result.meta.changes > 0;
}

async function isFirstRun(env: Env): Promise<boolean> {
  const row = await env.DB.prepare("SELECT 1 FROM seen LIMIT 1").first();
  return row === null;
}

// On the first run everything in the feed is old news: remember it silently.
async function seed(env: Env, items: FeedItem[]): Promise<void> {
  const now = new Date().toISOString();
  const stmt = env.DB.prepare(
    "INSERT OR IGNORE INTO seen (guid, title, link, first_seen_at, sent_at) VALUES (?, ?, ?, ?, ?)",
  );
  await env.DB.batch(items.map((i) => stmt.bind(i.guid, i.title, i.link, now, now)));
}

// A silently broken bot means a missed drop, so say when polling keeps failing.
async function recordFailure(env: Env): Promise<void> {
  const failures = Number((await getState(env, "failures")) ?? 0) + 1;
  await setState(env, "failures", String(failures));
  if (failures === Number(env.FAILURE_ALERT_THRESHOLD)) {
    await broadcast(env, `⚠️ Не могу прочитать ленту 44 Label уже ${failures} раз подряд. Проверь сайт или бота.`);
  }
}

async function recordSuccess(env: Env): Promise<void> {
  const failures = Number((await getState(env, "failures")) ?? 0);
  if (failures === 0) return;
  await setState(env, "failures", "0");
  if (failures >= Number(env.FAILURE_ALERT_THRESHOLD)) {
    await broadcast(env, "✅ Лента 44 Label снова читается, слежу дальше.");
  }
}

async function getState(env: Env, key: string): Promise<string | null> {
  return env.DB.prepare("SELECT value FROM state WHERE key = ?").bind(key).first<string>("value");
}

async function setState(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  )
    .bind(key, value)
    .run();
}

async function broadcast(env: Env, text: string): Promise<void> {
  for (const chatId of chatIds(env)) {
    await sendText(env.TELEGRAM_BOT_TOKEN, chatId, text).catch((err) => console.error(err));
  }
}

function chatIds(env: Env): string[] {
  return env.TELEGRAM_CHAT_ID.split(",").map((id) => id.trim()).filter(Boolean);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
