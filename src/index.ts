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

  if (await isFirstRun(env)) {
    await seed(env, items);
    await broadcast(env, `Бот запущен. Слежу за ${env.FEED_URL}, уже в ленте: ${items.length}.`);
    return;
  }

  // Oldest first, so several new records arrive in release order.
  for (const item of [...items].reverse()) {
    if (!(await claim(env, item))) continue;
    try {
      const price = await fetchPrice(item.link);
      for (const chatId of chatIds(env)) {
        await sendAlert(env.TELEGRAM_BOT_TOKEN, chatId, item, price);
      }
      console.log("alerted", item.guid, item.title);
    } catch (err) {
      // Release the claim so the next poll retries this item.
      console.error("alert failed", item.guid, err);
      await env.DB.prepare("DELETE FROM seen WHERE guid = ?").bind(item.guid).run();
    }
  }
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

// INSERT OR IGNORE is atomic, so overlapping polls can't alert the same item twice.
async function claim(env: Env, item: FeedItem): Promise<boolean> {
  const result = await env.DB.prepare(
    "INSERT OR IGNORE INTO seen (guid, title, link, first_seen_at) VALUES (?, ?, ?, ?)",
  )
    .bind(item.guid, item.title, item.link, new Date().toISOString())
    .run();
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
    "INSERT OR IGNORE INTO seen (guid, title, link, first_seen_at) VALUES (?, ?, ?, ?)",
  );
  await env.DB.batch(items.map((i) => stmt.bind(i.guid, i.title, i.link, now)));
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
