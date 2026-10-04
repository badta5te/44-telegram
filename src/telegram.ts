import { FeedItem, isPreOrder } from "./feed";

const CAPTION_LIMIT = 1024;

export function buildCaption(item: FeedItem, price?: string): string {
  const lines = [`🆕 <b>${escapeHtml(item.title)}</b>`];
  if (price) lines.push(`💶 ${escapeHtml(price)}`);
  if (isPreOrder(item)) lines.push("📦 Предзаказ");

  const description = item.description.replace(/<[^>]+>/g, "").trim();
  if (description) lines.push("", escapeHtml(description));

  lines.push("", escapeHtml(item.link));
  const caption = lines.join("\n");
  return caption.length > CAPTION_LIMIT ? caption.slice(0, CAPTION_LIMIT - 1) + "…" : caption;
}

export async function sendAlert(
  token: string,
  chatId: string,
  item: FeedItem,
  price?: string,
): Promise<void> {
  const caption = buildCaption(item, price);
  const reply_markup = { inline_keyboard: [[{ text: "Открыть в магазине", url: item.link }]] };

  if (item.imageUrl) {
    const ok = await call(token, "sendPhoto", {
      chat_id: chatId,
      photo: item.imageUrl,
      caption,
      parse_mode: "HTML",
      reply_markup,
    }).then(() => true, () => false);
    if (ok) return;
    // Telegram sometimes can't fetch the image; fall through to plain text.
  }

  await call(token, "sendMessage", {
    chat_id: chatId,
    text: caption,
    parse_mode: "HTML",
    reply_markup,
  });
}

export async function sendText(token: string, chatId: string, text: string): Promise<void> {
  await call(token, "sendMessage", { chat_id: chatId, text });
}

async function call(token: string, method: string, body: unknown): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Telegram ${method} failed: ${res.status} ${await res.text()}`);
  }
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
