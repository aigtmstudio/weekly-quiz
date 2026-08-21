import { describe, expect, it } from "vitest";

import { dailyEmail } from "@/lib/email/templates";
import type { Fact } from "@/lib/types";

/**
 * The picture round is built from facts that went out with a picture, so a
 * briefing that quietly drops its images makes the next quiz unanswerable.
 * Gmail does not reliably render `data:` URIs either, which is why these have
 * to be attachments referenced by content ID.
 */

function fact(overrides: Partial<Fact> = {}): Fact {
  return {
    id: "id-1",
    fact_key: "stonehenge-2026-08-21",
    publish_date: "2026-08-21",
    position: 1,
    topic: "history",
    title: "Stonehenge was nearly sold for scrap",
    key_fact: "It changed hands at auction in 1915 for £6,600.",
    story: "A local man bought it on a whim. His wife was unimpressed. He gave it away.",
    tags: [],
    source: null,
    image_subject: null,
    image_path: null,
    image_credit: null,
    created_at: "2026-08-21T01:00:00Z",
    ...overrides,
  };
}

const illustrated = fact({
  image_subject: "Stonehenge",
  image_path: "https://blob/fact-images/stonehenge-2026-08-21.jpg",
  image_credit: "Someone — CC BY-SA",
});

const input = {
  date: "2026-08-21",
  facts: [illustrated],
  repeats: [],
  siteUrl: "https://example.test",
  unsubscribeUrl: "https://example.test/unsubscribe?token=x",
};

describe("dailyEmail", () => {
  it("attaches each picture by content ID rather than inlining it", () => {
    const body = dailyEmail(input);

    expect(body.images).toEqual([
      { cid: "f1", url: illustrated.image_path, filename: "f1.jpg" },
    ]);
    expect(body.html).toContain('src="cid:f1"');
    expect(body.html).not.toContain("data:image");
  });

  it("credits the picture", () => {
    expect(dailyEmail(input).html).toContain("Someone — CC BY-SA");
  });

  it("sends the fact without a picture when there isn't one", () => {
    const body = dailyEmail({ ...input, facts: [fact()] });

    expect(body.images).toEqual([]);
    expect(body.html).not.toContain("cid:");
    expect(body.html).toContain("nearly sold for scrap");
  });

  it("shows the pictures of resurfaced facts too", () => {
    const body = dailyEmail({
      ...input,
      facts: [fact()],
      repeats: [illustrated],
    });

    expect(body.images).toHaveLength(1);
    expect(body.html).toContain("Worth another look");
  });

  it("says how many facts there are", () => {
    expect(dailyEmail({ ...input, facts: [illustrated, fact()] }).subject).toBe(
      "2 facts — 21 Aug",
    );
  });
});
