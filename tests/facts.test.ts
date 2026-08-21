import { describe, expect, it, vi } from "vitest";

import { addDays, isFirstOfMonth, isMonday, monthKey, weekKey } from "@/lib/dates";
import {
  FACTS_PER_DAY,
  FACT_IMAGE_FOLDER,
  RESTING_TOPICS,
  TOPICS,
  assignFactKeys,
  factKey,
  slugify,
  storeFactImages,
  topicsForDate,
} from "@/lib/facts";
import { ImageError } from "@/lib/images";

const resting = (date: string) => TOPICS.filter((t) => !topicsForDate(date).includes(t));

describe("topicsForDate", () => {
  it("publishes eight topics a day and rests the remainder", () => {
    expect(topicsForDate("2026-08-10")).toHaveLength(FACTS_PER_DAY);
    expect(TOPICS).toHaveLength(FACTS_PER_DAY + RESTING_TOPICS);
    expect(resting("2026-08-10")).toHaveLength(RESTING_TOPICS);
  });

  it("divides evenly, so no topic gets a longer rest than the others", () => {
    // If this fails the rotation would stutter at the wrap-around.
    expect(TOPICS.length % RESTING_TOPICS).toBe(0);
  });

  it("never rests the same topic two days running", () => {
    let date = "2026-08-10";
    for (let i = 0; i < 40; i++) {
      const next = addDays(date, 1);
      const overlap = resting(date).filter((t) => resting(next).includes(t));

      expect(overlap).toEqual([]);
      date = next;
    }
  });

  it("works out the same every time for a given date", () => {
    expect(topicsForDate("2026-08-10")).toEqual(topicsForDate("2026-08-10"));
  });

  it("covers every topic across one full cycle", () => {
    const cycle = TOPICS.length / RESTING_TOPICS;
    const seen = new Set<string>();
    let date = "2026-08-10";
    for (let i = 0; i < cycle; i++) {
      for (const topic of topicsForDate(date)) seen.add(topic);
      date = addDays(date, 1);
    }
    expect(seen.size).toBe(TOPICS.length);
  });

  it("keeps the closest-related topics from resting together", () => {
    // Science and the natural world overlap most, as do art and music; a day
    // missing both of a pair would read as a noticeably thinner briefing.
    const pairs = [
      ["science", "natural world"],
      ["art and literature", "music"],
    ];
    let date = "2026-08-10";
    for (let i = 0; i < 20; i++) {
      const out = resting(date);
      for (const [a, b] of pairs) {
        expect(out.includes(a as never) && out.includes(b as never)).toBe(false);
      }
      date = addDays(date, 1);
    }
  });
});

describe("factKey", () => {
  it("is stable for the same title and date", () => {
    expect(factKey("The Siege of Malta", "2026-08-10")).toBe(
      factKey("The Siege of Malta", "2026-08-10"),
    );
  });

  it("distinguishes the same subject published on different days", () => {
    expect(factKey("Halley's Comet", "2026-08-10")).not.toBe(
      factKey("Halley's Comet", "2026-08-11"),
    );
  });

  it("strips punctuation and accents out of the slug", () => {
    expect(slugify("Émile Zola's J'Accuse…!")).toBe("emile-zola-s-j-accuse");
  });
});

describe("assignFactKeys", () => {
  it("keeps two facts published the same day under the same title apart", () => {
    const keys = assignFactKeys(["Ketchup as medicine", "Ketchup as medicine"], "2026-08-02");

    expect(new Set(keys).size).toBe(2);
    expect(keys[0]).toBe(factKey("Ketchup as medicine", "2026-08-02"));
  });

  it("leaves distinct titles alone", () => {
    const titles = ["First thing", "Second thing", "Third thing"];
    const keys = assignFactKeys(titles, "2026-08-02");

    expect(keys).toEqual(titles.map((title) => factKey(title, "2026-08-02")));
  });

  it("copes with more than two collisions", () => {
    const keys = assignFactKeys(Array(4).fill("Same title"), "2026-08-02");

    expect(new Set(keys).size).toBe(4);
  });
});

describe("scheduling", () => {
  it("knows which days a quiz is due", () => {
    expect(isMonday("2026-08-10")).toBe(true);
    expect(isMonday("2026-08-11")).toBe(false);
    expect(isFirstOfMonth("2026-08-01")).toBe(true);
    expect(isFirstOfMonth("2026-08-02")).toBe(false);
  });

  it("gives every day of a week the same weekly key", () => {
    const keys = new Set(
      ["2026-08-10", "2026-08-12", "2026-08-16"].map((date) => weekKey(date)),
    );
    expect(keys.size).toBe(1);
  });

  it("changes the weekly key on the following Monday", () => {
    expect(weekKey("2026-08-10")).not.toBe(weekKey("2026-08-17"));
  });

  it("keys months plainly", () => {
    expect(monthKey("2026-08-10")).toBe("2026-08");
  });
});

describe("storeFactImages", () => {
  const facts = [
    { fact_key: "a", title: "A", image_subject: "Stonehenge" },
    { fact_key: "b", title: "B", image_subject: "Concorde" },
  ];

  function store(failing = new Set<string>()) {
    return vi.fn(async (article: string) => {
      if (failing.has(article)) throw new ImageError(`"${article}" has no lead image`);
      return { imagePath: `https://blob/${article}.jpg`, imageCredit: "Wikipedia" };
    });
  }

  it("files pictures under the fact's own key, apart from quiz images", async () => {
    const stored = store();
    await storeFactImages(facts, stored);

    expect(stored).toHaveBeenCalledWith("Stonehenge", "a", expect.anything(), FACT_IMAGE_FOLDER);
  });

  it("publishes the rest of the briefing when one subject has no picture", async () => {
    const images = await storeFactImages(facts, store(new Set(["Stonehenge"])));

    expect(images.has("a")).toBe(false);
    expect(images.get("b")?.imagePath).toBe("https://blob/Concorde.jpg");
  });

  it("does not go looking for a picture the fact never nominated", async () => {
    const stored = store();
    const images = await storeFactImages([{ ...facts[0], image_subject: "  " }], stored);

    expect(stored).not.toHaveBeenCalled();
    expect(images.size).toBe(0);
  });

  it("lets an unexpected failure through rather than quietly dropping pictures", async () => {
    const stored = vi.fn(async () => {
      throw new TypeError("blob store misconfigured");
    });

    await expect(storeFactImages(facts, stored)).rejects.toThrow(TypeError);
  });
});
