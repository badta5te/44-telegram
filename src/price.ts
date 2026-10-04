// The RSS feed has no price, so we read it from the product page.
// Best effort: an alert without a price beats a late alert.
export async function fetchPrice(url: string, timeoutMs = 2500): Promise<string | undefined> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return undefined;
    return extractPrice(await res.text());
  } catch {
    return undefined;
  }
}

export function extractPrice(html: string): string | undefined {
  const amount = meta(html, "product:price:amount");
  const currency = meta(html, "product:price:currency");
  if (amount) return formatPrice(amount, currency);

  // Fallback: Squarespace embeds product data as JSON in the page.
  const money = html.match(/"priceMoney"\s*:\s*\{\s*"currency"\s*:\s*"([A-Z]{3})"\s*,\s*"value"\s*:\s*"([\d.]+)"/);
  if (money) return formatPrice(money[2], money[1]);

  return undefined;
}

function meta(html: string, property: string): string | undefined {
  const tags = html.match(/<meta\s[^>]*>/gi) ?? [];
  for (const t of tags) {
    if (!t.includes(`"${property}"`)) continue;
    const content = t.match(/content="([^"]*)"/i);
    if (content) return content[1];
  }
  return undefined;
}

const CURRENCY_SIGNS: Record<string, string> = { EUR: "€", USD: "$", GBP: "£" };

function formatPrice(amount: string, currency?: string): string {
  const value = Number(amount);
  const pretty = Number.isFinite(value) ? value.toFixed(2) : amount;
  if (!currency) return pretty;
  const sign = CURRENCY_SIGNS[currency.toUpperCase()];
  return sign ? `${pretty} ${sign}` : `${pretty} ${currency}`;
}

export const USER_AGENT = "44-telegram-bot (+https://github.com/badta5te/44-telegram)";
