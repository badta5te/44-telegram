# 44-telegram

A Telegram bot that alerts you about every new record on [44-label.group](https://44-label.group/shop).

## How it works

- A Cloudflare Worker runs on a cron every minute and reads the shop's RSS feed at `https://44-label.group/shop?format=rss`.
- During minutes `:59, :00, :01, :02` (UTC) the worker polls every 15 seconds, because releases go live exactly on the hour.
- Seen items are stored in D1 by `guid`. A new `guid` means a new item: the bot sends the cover photo, title, price (taken from the product page), a pre-order mark and a button linking to the shop.
- On the first run everything already in the feed is remembered silently, so you don't get 20 old records at once.
- If an alert fails to send, it is retried on the next poll.
- If the feed can't be read 10 times in a row, the bot warns you, and tells you again once it recovers.

## Deploy

You need a Cloudflare account (the free plan is enough) and Node.js 20+.

```sh
npm install
npx wrangler login

# Database for seen items; copy database_id into wrangler.toml
npx wrangler d1 create 44-telegram
npm run db:migrate

# Secrets
npx wrangler secret put TELEGRAM_BOT_TOKEN   # token from @BotFather
npx wrangler secret put TELEGRAM_CHAT_ID     # your chat id, several allowed, comma-separated

npm run deploy
```

To find your `TELEGRAM_CHAT_ID`, send the bot any message and open
`https://api.telegram.org/bot<TOKEN>/getUpdates`: the number is in `message.chat.id`.

## Testing

Within a minute of deploying you'll get a "bot started" message. To get a test alert for a real record, delete it from the database and the bot will send it on the next poll:

```sh
npx wrangler d1 execute 44-telegram --remote \
  --command "DELETE FROM seen WHERE guid = (SELECT guid FROM seen ORDER BY rowid LIMIT 1)"
```

Logs: `npx wrangler tail`.

## Development

```sh
npm test          # feed parser, price, alert logic
npm run typecheck
npm run dev       # local run; trigger the cron with curl "http://localhost:8787/__scheduled"
```

Settings live in `wrangler.toml` under `[vars]`: feed URL, burst minutes, burst interval and the failure warning threshold.
