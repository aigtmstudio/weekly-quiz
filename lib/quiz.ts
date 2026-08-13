import { generateJson } from "@/lib/claude";
import { addDays, endOfMonth, formatLong, startOfMonth } from "@/lib/dates";
import { slugify } from "@/lib/facts";
import { ImageError, storeImage } from "@/lib/images";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Cadence, Fact, Quiz } from "@/lib/types";

/**
 * Quiz assembly.
 *
 * Two rules matter more than the rest: no multiple choice anywhere, and
 * publishing a quiz is entirely separate from anybody attempting it. A quiz row
 * is never touched by a player.
 */

/** Written formats. `picture` is handled separately; legacy formats are archive. */
export const WRITTEN_FORMATS = [
  "open_recall",
  "fill_blank",
  "explain_why",
  "explain_significance",
  "reverse",
] as const;

export interface CadenceSpec {
  writtenCount: number;
  pictureTarget: number;
  pictureCandidates: number;
  crossFactMinimum: number;
}

export const SPEC: Record<Cadence, CadenceSpec> = {
  // 9 written + 3-4 pictures lands inside the 10-15 the weekly quiz wants.
  weekly: {
    writtenCount: 9,
    pictureTarget: 4,
    pictureCandidates: 7,
    crossFactMinimum: 0,
  },
  // 15 written + 5 pictures = 20.
  monthly: {
    writtenCount: 15,
    pictureTarget: 5,
    pictureCandidates: 8,
    crossFactMinimum: 3,
  },
};

export const MIN_PICTURES = 3;

export interface GeneratedWritten {
  fact_keys: string[];
  format: (typeof WRITTEN_FORMATS)[number];
  prompt: string;
  correct_answer: string;
  accepted_answers: string[];
  explanation: string;
}

export interface GeneratedPicture {
  fact_keys: string[];
  wikipedia_article: string;
  prompt: string;
  correct_answer: string;
  accepted_answers: string[];
  explanation: string;
}

export interface GeneratedQuiz {
  questions: GeneratedWritten[];
  picture_candidates: GeneratedPicture[];
}

const ANSWER_PROPS = {
  correct_answer: {
    type: "string",
    description: "The expected answer, as briefly as it can be stated.",
  },
  accepted_answers: {
    type: "array",
    items: { type: "string" },
    description:
      "Other spellings, shorter forms or equivalent phrasings that should also count. Do not repeat correct_answer.",
  },
  explanation: {
    type: "string",
    description: "One or two sentences explaining the answer, shown after submission.",
  },
} as const;

function schemaFor(spec: CadenceSpec, factKeys: string[]) {
  return {
    type: "object",
    properties: {
      questions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            fact_keys: {
              type: "array",
              items: { type: "string", enum: factKeys },
              description:
                "The fact or facts this question tests. Two entries means it connects two separate facts.",
            },
            format: { type: "string", enum: [...WRITTEN_FORMATS] },
            prompt: { type: "string" },
            ...ANSWER_PROPS,
          },
          required: [
            "fact_keys",
            "format",
            "prompt",
            "correct_answer",
            "accepted_answers",
            "explanation",
          ],
          additionalProperties: false,
        },
      },
      picture_candidates: {
        type: "array",
        items: {
          type: "object",
          properties: {
            fact_keys: { type: "array", items: { type: "string", enum: factKeys } },
            wikipedia_article: {
              type: "string",
              description:
                "Exact title of the English Wikipedia article whose lead image should be shown.",
            },
            prompt: { type: "string" },
            ...ANSWER_PROPS,
          },
          required: [
            "fact_keys",
            "wikipedia_article",
            "prompt",
            "correct_answer",
            "accepted_answers",
            "explanation",
          ],
          additionalProperties: false,
        },
      },
    },
    required: ["questions", "picture_candidates"],
    additionalProperties: false,
  };
}

const SYSTEM = `You set pub quizzes for two people from facts they have already read.
The point is recall — whether the fact stuck — not whether they can guess.

Absolute rules:
- Never write a multiple-choice question. No options, no "which of the following".
- Every question must be answerable from the facts supplied, and must have one
  clear answer a person would either know or not.
- Never give the answer away inside the prompt.

The formats:
- open_recall — straight question about the fact.
- fill_blank — a sentence from the fact with one telling word or number removed,
  written with "____" where the answer goes.
- explain_why — asks for the reason behind something.
- explain_significance — asks what made it matter.
- reverse — gives the detail and asks what it belongs to.

Use several different formats; do not lean on one.

"accepted_answers" is where you are generous. Include shortened forms, common
alternative spellings, with and without "the", surname alone where a full name is
the answer. Grading is exact-match after case and punctuation are stripped, so
anything a reasonable person might type has to be listed.

For picture questions, name the English Wikipedia article whose lead image shows
the subject. Choose landmarks, flags, maps, machinery, animals, diagrams or
historic photographs. Do not choose living people, album or film artwork, or
paintings still in copyright. The article must be one with a lead image.

British spelling throughout.`;

function factBrief(facts: Fact[]): string {
  return facts
    .map(
      (fact) =>
        `[${fact.fact_key}] (${fact.topic}, ${fact.publish_date}) ${fact.title}\n  ${fact.key_fact}\n  ${fact.story}`,
    )
    .join("\n\n");
}

/**
 * Everything the structured-output schema can't enforce.
 *
 * Structured outputs ignore minItems/maxItems, and nothing in a schema can
 * express "use at least four different formats" or "three of these must join
 * two facts". A failure message here is fed back to the model on the retry, so
 * each one says what is actually wrong.
 */
export function validateGeneratedQuiz(
  value: GeneratedQuiz,
  spec: CadenceSpec,
  factKeys: string[],
): void {
  if (value.questions.length !== spec.writtenCount) {
    throw new Error(
      `expected exactly ${spec.writtenCount} written questions, got ${value.questions.length}`,
    );
  }
  if (value.picture_candidates.length !== spec.pictureCandidates) {
    throw new Error(
      `expected exactly ${spec.pictureCandidates} picture questions, got ${value.picture_candidates.length}`,
    );
  }

  const notWritten = value.questions.find(
    (question) => !WRITTEN_FORMATS.includes(question.format),
  );
  if (notWritten) {
    throw new Error(`"${notWritten.format}" is not one of the allowed formats`);
  }

  const formats = new Set(value.questions.map((q) => q.format));
  if (formats.size < 4) {
    throw new Error(
      `only ${formats.size} question formats used; use at least four of the five`,
    );
  }

  const crossFact = value.questions.filter((q) => q.fact_keys.length >= 2).length;
  if (crossFact < spec.crossFactMinimum) {
    throw new Error(
      `only ${crossFact} questions connect two facts; at least ${spec.crossFactMinimum} must`,
    );
  }

  const all = [...value.questions, ...value.picture_candidates];
  const orphan = all.find((q) => q.fact_keys.length === 0);
  if (orphan) {
    throw new Error(`"${orphan.prompt}" is not attached to any fact`);
  }
  const unknown = all.flatMap((q) => q.fact_keys).find((key) => !factKeys.includes(key));
  if (unknown) {
    throw new Error(`fact_keys contains "${unknown}", which is not one of the facts`);
  }
  const leaky = all.find((q) =>
    q.prompt.toLowerCase().includes(q.correct_answer.toLowerCase().trim()),
  );
  if (leaky) {
    throw new Error(`"${leaky.prompt}" contains its own answer`);
  }
}

export async function generateQuiz(
  cadence: Cadence,
  facts: Fact[],
  periodStart: string,
  periodEnd: string,
): Promise<GeneratedQuiz> {
  const spec = SPEC[cadence];
  const factKeys = facts.map((f) => f.fact_key);

  const monthlyExtra =
    cadence === "monthly"
      ? `\n\nThis is the monthly quiz, so pitch it harder than a weekly one. Group the
questions loosely by topic rather than scattering them. At least ${spec.crossFactMinimum}
of the written questions must connect two separate facts — give those two entries
in fact_keys.`
      : "";

  const prompt = `Facts covered between ${formatLong(periodStart)} and ${formatLong(periodEnd)}:

${factBrief(facts)}

Write exactly ${spec.writtenCount} written questions and exactly ${spec.pictureCandidates}
picture questions.

More picture questions are requested than will be used, because some Wikipedia
articles turn out to have no usable lead image. Order them best first.${monthlyExtra}`;

  return generateJson<GeneratedQuiz>({
    system: SYSTEM,
    prompt,
    schema: schemaFor(spec, factKeys) as unknown as Record<string, unknown>,
    effort: "high",
    validate: (value) => validateGeneratedQuiz(value, spec, factKeys),
  });
}

export interface ResolvedPicture extends GeneratedPicture {
  image_path: string;
  image_credit: string;
}

/**
 * Work down the candidates resolving images until `target` are in hand.
 *
 * Candidates whose article has no lead image are skipped, never substituted —
 * showing the wrong picture is worse than a shorter picture round.
 */
export async function resolvePictures(
  candidates: GeneratedPicture[],
  target: number,
  store: typeof storeImage = storeImage,
): Promise<{ pictures: ResolvedPicture[]; skipped: string[] }> {
  const pictures: ResolvedPicture[] = [];
  const skipped: string[] = [];

  for (const candidate of candidates) {
    if (pictures.length >= target) break;
    try {
      const { imagePath, imageCredit } = await store(
        candidate.wikipedia_article,
        slugify(candidate.wikipedia_article),
      );
      pictures.push({ ...candidate, image_path: imagePath, image_credit: imageCredit });
    } catch (error) {
      if (!(error instanceof ImageError)) throw error;
      skipped.push(`${candidate.wikipedia_article}: ${error.message}`);
    }
  }

  return { pictures, skipped };
}

export function periodFor(cadence: Cadence, date: string): { start: string; end: string } {
  if (cadence === "weekly") {
    // Runs on a Monday, covering the seven days that just finished.
    return { start: addDays(date, -7), end: addDays(date, -1) };
  }
  const previousMonth = addDays(startOfMonth(date), -1);
  return { start: startOfMonth(previousMonth), end: endOfMonth(previousMonth) };
}

export interface PublishResult {
  quiz: Quiz;
  questionCount: number;
  pictureCount: number;
  skippedImages: string[];
}

export async function publishQuiz(
  cadence: Cadence,
  date: string,
): Promise<PublishResult | null> {
  const db = createAdminClient();
  const spec = SPEC[cadence];
  const { start, end } = periodFor(cadence, date);

  const { data: facts, error: factsError } = await db
    .from("pqb_facts")
    .select("*")
    .gte("publish_date", start)
    .lte("publish_date", end)
    .order("publish_date")
    .order("position");
  if (factsError) throw factsError;

  if (!facts || facts.length < spec.writtenCount) {
    // Not enough material — better no quiz than a padded one.
    return null;
  }

  const generated = await generateQuiz(cadence, facts, start, end);
  const { pictures, skipped } = await resolvePictures(
    generated.picture_candidates,
    spec.pictureTarget,
  );

  // Insert unpublished first, so a failure part-way never leaves a current quiz
  // with no questions in it.
  const { data: quiz, error: quizError } = await db
    .from("pqb_quizzes")
    .insert({
      cadence,
      period_start: start,
      period_end: end,
      is_current: false,
    })
    .select()
    .single();
  if (quizError) throw quizError;

  const rows = [
    ...generated.questions.map((question, index) => ({
      quiz_id: quiz.id,
      fact_key: question.fact_keys[0] ?? null,
      format: question.format,
      prompt: question.prompt,
      correct_answer: question.correct_answer,
      accepted_answers: question.accepted_answers,
      explanation: question.explanation,
      image_path: null,
      image_credit: null,
      position: index + 1,
    })),
    ...pictures.map((picture, index) => ({
      quiz_id: quiz.id,
      fact_key: picture.fact_keys[0] ?? null,
      format: "picture" as const,
      prompt: picture.prompt,
      correct_answer: picture.correct_answer,
      accepted_answers: picture.accepted_answers,
      explanation: picture.explanation,
      image_path: picture.image_path,
      image_credit: picture.image_credit,
      position: generated.questions.length + index + 1,
    })),
  ];

  const { error: questionsError } = await db.from("pqb_questions").insert(rows);
  if (questionsError) throw questionsError;

  // Retire the previous quiz of this cadence, then make this one current. The
  // partial unique index allows only one current quiz per cadence, so the
  // retire has to land first.
  const { error: retireError } = await db
    .from("pqb_quizzes")
    .update({ is_current: false })
    .eq("cadence", cadence)
    .eq("is_current", true);
  if (retireError) throw retireError;

  const { data: published, error: publishError } = await db
    .from("pqb_quizzes")
    .update({ is_current: true })
    .eq("id", quiz.id)
    .select()
    .single();
  if (publishError) throw publishError;

  return {
    quiz: published,
    questionCount: rows.length,
    pictureCount: pictures.length,
    skippedImages: skipped,
  };
}
