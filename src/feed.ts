export interface FeedItem {
  guid: string;
  title: string;
  link: string;
  pubDate: string;
  description: string;
  imageUrl?: string;
}

export const PRE_ORDER_MARK = "[PRE-ORDER]";

// Squarespace RSS is small and regular, so a regex parser is enough here
// (Workers have no DOMParser).
export function parseFeed(xml: string): FeedItem[] {
  const items: FeedItem[] = [];
  for (const [, body] of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const guid = tag(body, "guid");
    const link = tag(body, "link");
    if (!guid || !link) continue;

    items.push({
      guid,
      link,
      title: tag(body, "title") ?? "",
      pubDate: tag(body, "pubDate") ?? "",
      description: tag(body, "description") ?? "",
      imageUrl: attr(body, "media:content", "url"),
    });
  }
  return items;
}

// Most polls see a feed with nothing new, so they only need the guids: one cheap scan
// instead of a full parse keeps a run inside the 10 ms free-tier CPU limit.
export function feedGuids(xml: string): string[] {
  return [...xml.matchAll(/<guid(?:\s[^>]*)?>([\s\S]*?)<\/guid>/g)]
    .map(([, guid]) => decode(guid).trim())
    .filter(Boolean);
}

export function isPreOrder(item: FeedItem): boolean {
  return item.title.toUpperCase().includes(PRE_ORDER_MARK);
}

function tag(xml: string, name: string): string | undefined {
  const match = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
  if (!match) return undefined;
  return decode(match[1]).trim();
}

function attr(xml: string, name: string, attribute: string): string | undefined {
  const el = xml.match(new RegExp(`<${name}\\s[^>]*>`));
  if (!el) return undefined;
  const value = el[0].match(new RegExp(`\\s${attribute}="([^"]*)"`));
  return value ? decode(value[1]) : undefined;
}

function decode(text: string): string {
  const cdata = text.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  if (cdata) return cdata[1];

  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&amp;/g, "&");
}
