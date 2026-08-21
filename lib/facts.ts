import { generateJson } from "@/lib/claude";
import { addDays, daysBetween, formatLong } from "@/lib/dates";
import { ImageError, storeImage } from "@/lib/images";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Fact } from "@/lib/types";

/**
 * The rotation pool. Eight facts a day, so two topics rest each day.
 *
 * Order is load-bearing: topics rest in adjacent pairs, so the list is
 * interleaved to keep each resting pair dissimilar. Science and the natural
 * world never sit out together, nor do art and music.
 */
export const TOPICS = [
  "history",
  "music",
  "geography",
  "food and drink",
  "science",
  "art and literature",
  "sport",
  "popular culture",
  "politics",
  "natural world",
] as const;

export type Topic = (typeof TOPICS)[number];

export const FACTS_PER_DAY = 8;

/** Blob folder for fact pictures, kept apart from quiz images. */
export const FACT_IMAGE_FOLDER = "fact-images";

/** How many topics sit out each day. */
export const RESTING_TOPICS = TOPICS.length - FACTS_PER_DAY;

/**
 * Which topics today gets.
 *
 * Rotating in code rather than asking the model to remember guarantees no
 * topic rests two days running, and makes the behaviour testable. The window
 * advances by exactly the number of resting topics, so the whole pool is
 * covered every TOPICS.length / RESTING_TOPICS days.
 */
export function topicsForDate(date: string): Topic[] {
  const cycle = TOPICS.length / RESTING_TOPICS;
  const day = ((daysBetween("2026-01-01", date) % cycle) + cycle) % cycle;
  const first = day * RESTING_TOPICS;
  const resting = new Set<string>(TOPICS.slice(first, first + RESTING_TOPICS));
  return TOPICS.filter((topic) => !resting.has(topic));
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export function factKey(title: string, publishDate: string): string {
  return `${slugify(title)}-${publishDate}`;
}

/**
 * Keys for one day's facts, guaranteed distinct.
 *
 * Two facts published the same day under the same title collide — rare, but it
 * has already happened once in the legacy data, and fact_key is unique, so the
 * whole day's insert would fail. Suffix the later ones rather than lose them.
 */
export function assignFactKeys(titles: string[], publishDate: string): string[] {
  const used = new Set<string>();
  return titles.map((title) => {
    const base = factKey(title, publishDate);
    let key = base;
    let n = 2;
    while (used.has(key)) key = `${base}-${n++}`;
    used.add(key);
    return key;
  });
}

export interface GeneratedFact {
  topic: string;
  title: string;
  key_fact: string;
  story: string;
  tags: string[];
  image_subject: string;
}

const FACTS_SCHEMA = {
  type: "object",
  properties: {
    facts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          topic: { type: "string", enum: [...TOPICS] },
          title: {
            type: "string",
            description: "Short subject line, 3-8 words. No trailing punctuation.",
          },
          key_fact: {
            type: "string",
            description: "The fact itself, as one punchy sentence.",
          },
          story: {
            type: "string",
            description: "Three or four sentences of context behind the fact.",
          },
          tags: {
            type: "array",
            items: { type: "string" },
            description: "Two to four lowercase keywords.",
          },
          image_subject: {
            type: "string",
            description:
              "Exact title of the English Wikipedia article whose lead image shows the subject of this fact. Empty string if the fact has no thing worth looking at.",
          },
        },
        required: ["topic", "title", "key_fact", "story", "tags", "image_subject"],
        additionalProperties: false,
      },
    },
  },
  required: ["facts"],
  additionalProperties: false,
} as const;

const SYSTEM = `You write a daily briefing of interesting facts for two people who
enjoy pub quizzes. They are British.

What makes a good fact here:
- Built on a subject a pub quizzer would recognise. This is the most important
  rule and the easiest to get wrong. Aim for a famous subject with a
  lesser-known detail, not an obscure subject with an interesting detail. The
  Hubble telescope, the Beatles, Wembley, Chernobyl, Guinness, the Mona Lisa,
  the Tube — these are the kinds of things quizzes are actually set on. If the
  fact needs a sentence explaining what the subject even is before it can land,
  choose something else.
- Worth saying out loud to someone else. Prefer facts that carry a story or a
  punchline — a mishap, a piece of stubbornness, an unintended consequence, a
  decision that looks absurd in hindsight. If a fact has no more to it than the
  bare figure, it is a weaker choice than one that does.
- Specific enough to be quizzable later. Names, numbers, dates and places are
  the point.
- True and checkable. If a claim is commonly repeated but disputed, say so or
  pick something else. A good story that turns out to be a myth is worse than no
  fact at all.
- Avoid only the dozen or so facts that appear on every trivia listicle — Big
  Ben being the bell, Nelson's missing eye. Do not chase obscurity to avoid
  them; a well-known subject most people still could not quiz on is exactly
  right.

Format for each fact:
- "key_fact" is one punchy sentence — the fact itself, no preamble.
- "story" is three or four sentences: how it came about, why it matters, or what
  makes it ridiculous. Let the funny ones be funny, but keep the telling dry and
  confident — the humour belongs in the facts, not in the delivery. No
  exclamation marks, no "did you know", no addressing the reader, no nudging the
  reader about how remarkable it is.

What each topic covers, so they don't overlap:
- history — events, people and institutions before living memory.
- politics — government, law, elections, diplomacy, and modern political history.
- geography — places, borders, cities, maps, and how the world is arranged.
- natural world — animals, plants, geology, weather, oceans.
- science — physics, chemistry, medicine, mathematics, space, and technology.
- art and literature — painting, sculpture, architecture, books, poetry, theatre,
  film and television.
- music — songs, artists, instruments, charts, recording and performance.
- popular culture — celebrity, the internet, fashion, brands, advertising, games
  and toys. Not film, television or music, which have their own topics.
- food and drink — dishes, ingredients, origins, brewing and distilling, customs.
- sport — football with a UK emphasis, tennis, golf, Formula 1, the NFL, the
  Olympics and athletics, or the Tour de France. Nothing outside that list.

For "image_subject", name the English Wikipedia article whose lead image shows
what the fact is about — the building, the object, the animal, the place, the
painting. These pictures are shown in the briefing and later used for the quiz's
picture round, so pick the thing a person would recognise on sight. Landmarks,
flags, maps, machinery, animals, artefacts, diagrams and historic photographs
all work. Leave it empty rather than reaching: an abstract fact about inflation
or a parliamentary procedure has nothing worth showing, and a weak picture is
worse than none. Do not choose living people, album or film artwork, or
paintings still in copyright.

British spelling throughout.`;

const IMAGE_SUBJECT_SCHEMA = {
  type: "object",
  properties: {
    subjects: {
      type: "array",
      items: {
        type: "object",
        properties: {
          fact_key: { type: "string" },
          image_subject: {
            type: "string",
            description:
              "Exact English Wikipedia article title whose lead image shows this fact's subject, or an empty string if there is nothing worth showing.",
          },
        },
        required: ["fact_key", "image_subject"],
        additionalProperties: false,
      },
    },
  },
  required: ["subjects"],
  additionalProperties: false,
} as const;

export interface FactForImage {
  fact_key: string;
  topic: string;
  title: string;
  key_fact: string;
}

/**
 * Pick a picture subject for facts that were written before the briefing
 * carried pictures. Same rules as the generator uses, applied after the fact.
 *
 * Returns fact_key → article title, empty string where nothing suits.
 */
export async function imageSubjectsFor(
  facts: FactForImage[],
): Promise<Map<string, string>> {
  if (facts.length === 0) return new Map();

  const { subjects } = await generateJson<{
    subjects: Array<{ fact_key: string; image_subject: string }>;
  }>({
    system: SYSTEM,
    prompt: `For each fact below, give the "image_subject" as described: the English
Wikipedia article whose lead image shows what the fact is about. Nothing else is
needed — no titles, no stories, just the subjects.

${facts.map((fact) => `[${fact.fact_key}] (${fact.topic}) ${fact.title}\n  ${fact.key_fact}`).join("\n\n")}

Return one entry for every fact, keeping the fact_key exactly as given.`,
    schema: IMAGE_SUBJECT_SCHEMA as unknown as Record<string, unknown>,
    effort: "low",
    validate: (value) => {
      const returned = new Set(value.subjects.map((s) => s.fact_key));
      const missing = facts.filter((fact) => !returned.has(fact.fact_key));
      if (missing.length) {
        throw new Error(
          `no image_subject for: ${missing.map((f) => f.fact_key).join(", ")}`,
        );
      }
    },
  });

  return new Map(subjects.map((s) => [s.fact_key, s.image_subject.trim()]));
}

interface GenerateOptions {
  date: string;
  topics: Topic[];
  /** Titles from the recent past, so subjects don't come round again. */
  recentTitles: string[];
}

export async function generateFacts({
  date,
  topics,
  recentTitles,
}: GenerateOptions): Promise<GeneratedFact[]> {
  const avoid = recentTitles.length
    ? `\n\nThese subjects have been covered in the last few weeks. Do not repeat them or anything closely overlapping:\n${recentTitles.map((t) => `- ${t}`).join("\n")}`
    : "";

  const prompt = `Write the briefing for ${formatLong(date)}.

Produce exactly ${topics.length} facts, exactly one for each of these topics, in this order:
${topics.map((t, i) => `${i + 1}. ${t}`).join("\n")}${avoid}`;

  const { facts } = await generateJson<{ facts: GeneratedFact[] }>({
    system: SYSTEM,
    prompt,
    schema: FACTS_SCHEMA as unknown as Record<string, unknown>,
    effort: "medium",
    validate: (value) => {
      if (value.facts.length !== topics.length) {
        throw new Error(
          `expected exactly ${topics.length} facts, got ${value.facts.length}`,
        );
      }
      const produced = value.facts.map((f) => f.topic);
      const missing = topics.filter((t) => !produced.includes(t));
      if (missing.length) {
        throw new Error(`missing a fact for: ${missing.join(", ")}`);
      }
      const thin = value.facts.find((f) => f.story.trim().split(/(?<=[.!?])\s+/).length < 3);
      if (thin) {
        throw new Error(`the story for "${thin.title}" is shorter than three sentences`);
      }
    },
  });

  return facts;
}

/**
 * Generate and store the day's facts. Returns the rows written.
 *
 * Callers wrap this in `runOnce`, so this does not re-check whether the day is
 * already populated — but the unique constraint on (publish_date, position)
 * would catch it anyway.
 */
export async function publishFacts(date: string): Promise<Fact[]> {
  const db = createAdminClient();

  const { data: recent, error: recentError } = await db
    .from("pqb_facts")
    .select("title")
    .gte("publish_date", addDays(date, -21))
    .lt("publish_date", date)
    .order("publish_date", { ascending: false })
    .limit(120);
  if (recentError) throw recentError;

  const topics = topicsForDate(date);
  const generated = await generateFacts({
    date,
    topics,
    recentTitles: (recent ?? []).map((row) => row.title),
  });

  const keys = assignFactKeys(
    generated.map((fact) => fact.title),
    date,
  );

  const images = await storeFactImages(
    generated.map((fact, index) => ({ ...fact, fact_key: keys[index] })),
  );

  const rows = generated.map((fact, index) => ({
    fact_key: keys[index],
    publish_date: date,
    position: index + 1,
    topic: fact.topic,
    title: fact.title,
    key_fact: fact.key_fact,
    story: fact.story,
    tags: fact.tags,
    source: null,
    image_subject: fact.image_subject.trim() || null,
    image_path: images.get(keys[index])?.imagePath ?? null,
    image_credit: images.get(keys[index])?.imageCredit ?? null,
  }));

  const { data, error } = await db.from("pqb_facts").insert(rows).select();
  if (error) throw error;
  return data ?? [];
}

/**
 * Fetch and store a picture for each fact that nominated a subject.
 *
 * A missing or illustration-less article is not a failure: the fact still
 * stands on its own, and a briefing without one picture is much better than no
 * briefing at all. Sequential rather than parallel — eight requests is nothing
 * to us, and hammering Wikipedia eight-wide for a personal app is bad manners.
 */
export async function storeFactImages(
  items: Array<{ fact_key: string; image_subject: string; title: string }>,
  store: typeof storeImage = storeImage,
): Promise<Map<string, { imagePath: string; imageCredit: string }>> {
  const stored = new Map<string, { imagePath: string; imageCredit: string }>();

  for (const item of items) {
    const subject = item.image_subject.trim();
    if (!subject) continue;
    try {
      stored.set(
        item.fact_key,
        await store(subject, item.fact_key, fetch, FACT_IMAGE_FOLDER),
      );
    } catch (error) {
      if (!(error instanceof ImageError)) throw error;
      console.warn(`No image for "${item.title}" (${subject}): ${error.message}`);
    }
  }

  return stored;
}
