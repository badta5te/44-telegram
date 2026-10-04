import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isPreOrder, parseFeed } from "../src/feed";
import { extractPrice } from "../src/price";
import { buildCaption } from "../src/telegram";

const xml = readFileSync(new URL("./fixtures/feed.xml", import.meta.url), "utf8");

describe("parseFeed", () => {
  const items = parseFeed(xml);

  it("reads every item in feed order", () => {
    expect(items.map((i) => i.guid.split(":").pop())).toEqual([
      "6ab30d0f44aea31d23df09f8",
      "6a96cbc3c90e0742ca2c319a",
      "old",
    ]);
  });

  it("decodes title, link, description and image", () => {
    expect(items[0]).toMatchObject({
      title: 'SOMEWHEN – 44030 12" VINYL [PRE-ORDER]',
      link: "https://44-label.group/shop/somewhen-44030-vinyl",
      description: "PRE-ORDER!\nORDERS WILL BE SHIPPED: JANUARY 2027",
      imageUrl: "https://images.squarespace-cdn.com/content/v1/59a0612acd39c3292adaf073/somewhen.jpg?format=1500w",
    });
    expect(items[1].title).toBe('AZZEL 447 & FRIENDS – 44029 12" VINYL [PRE-ORDER]');
    expect(items[1].imageUrl).toContain("format=1500w&x=1");
  });

  it("handles items without image or description", () => {
    expect(items[2].imageUrl).toBeUndefined();
    expect(items[2].description).toBe("");
  });

  it("detects pre-orders", () => {
    expect(items.map(isPreOrder)).toEqual([true, true, false]);
  });
});

describe("extractPrice", () => {
  it("reads Open Graph product price", () => {
    const html = `<meta property="product:price:amount" content="28.00" /><meta property="product:price:currency" content="EUR" />`;
    expect(extractPrice(html)).toBe("28.00 €");
  });

  it("falls back to Squarespace product JSON", () => {
    const html = `{"priceMoney":{"currency":"EUR","value":"31.5"}}`;
    expect(extractPrice(html)).toBe("31.50 €");
  });

  it("returns undefined when the page has no price", () => {
    expect(extractPrice("<html></html>")).toBeUndefined();
  });
});

describe("buildCaption", () => {
  it("escapes HTML and includes price, pre-order mark and link", () => {
    const [, azzel] = parseFeed(xml);
    const caption = buildCaption(azzel, "28.00 €");
    expect(caption).toContain("<b>AZZEL 447 &amp; FRIENDS");
    expect(caption).toContain("💶 28.00 €");
    expect(caption).toContain("📦 Предзаказ");
    expect(caption).toContain("https://44-label.group/shop/azzel-447-44029-vinyl");
  });
});
