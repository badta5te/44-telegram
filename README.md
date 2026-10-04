# 44-telegram

Telegram-бот, который присылает оповещение о каждой новой пластинке на [44-label.group](https://44-label.group/shop).

## Как работает

- Cloudflare Worker запускается по cron раз в минуту и читает RSS магазина `https://44-label.group/shop?format=rss`.
- В минуты `:59, :00, :01, :02` (UTC) воркер опрашивает ленту каждые 15 секунд, потому что релизы выходят ровно в начале часа.
- Уже виденные товары хранятся в D1 по `guid`. Новый `guid` означает новую позицию: бот присылает фото, название, цену (берёт со страницы товара), пометку о предзаказе и кнопку на магазин.
- При первом запуске всё, что уже есть в ленте, запоминается молча, чтобы не прислать 20 старых пластинок.
- Если ленту не удаётся прочитать 10 раз подряд, бот предупреждает, а когда всё восстановится, пишет об этом.

## Деплой

Нужен аккаунт Cloudflare (бесплатного плана хватает) и Node.js 20+.

```sh
npm install
npx wrangler login

# База для виденных позиций; скопируй database_id в wrangler.toml
npx wrangler d1 create 44-telegram
npm run db:migrate

# Секреты
npx wrangler secret put TELEGRAM_BOT_TOKEN   # токен от @BotFather
npx wrangler secret put TELEGRAM_CHAT_ID     # твой chat id, можно несколько через запятую

npm run deploy
```

Чтобы узнать `TELEGRAM_CHAT_ID`, напиши боту любое сообщение и открой
`https://api.telegram.org/bot<ТОКЕН>/getUpdates`: нужное число лежит в `message.chat.id`.

## Проверка

После деплоя в течение минуты придёт сообщение «Бот запущен». Чтобы получить тестовое оповещение о настоящей пластинке, удали её из базы, и бот пришлёт её на следующем опросе:

```sh
npx wrangler d1 execute 44-telegram --remote \
  --command "DELETE FROM seen WHERE guid = (SELECT guid FROM seen ORDER BY rowid LIMIT 1)"
```

Логи: `npx wrangler tail`.

## Разработка

```sh
npm test          # парсер ленты, цена, логика оповещений
npm run typecheck
npm run dev       # локально; cron дёргается через curl "http://localhost:8787/__scheduled"
```

Настройки в `wrangler.toml` → `[vars]`: адрес ленты, минуты частого опроса, интервал и порог предупреждения о сбоях.
