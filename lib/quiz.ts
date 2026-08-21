import { generateJson } from "@/lib/claude";
import { addDays, endOfMonth, formatLong, startOfMonth } from "@/lib/dates";
import { normalise } from "@/lib/grader";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Cadence, Fact, Quiz } from "@/lib/types";

/**
 * Quiz assembly.
 *
 * The rule that matters most: publishing a quiz is entirely separate from
 * anybody attempting it. A quiz row is never touched by a player.
 *
 * Most questions are multiple choice. The original rule was the opposite — no
 * multiple choice anywhere, on the grounds that picking one of four does not
 * prove a fact stuck — but a written answer to "why did X happen" cannot be
 * marked by string comparison, and a quiz that scores 1/13 on answers that were
 * substantially right is worse than one that is a little easier to guess. A
 * written answer is kept only where the answer is a short name or number, which
 * is enforced below: anything longer has to be multiple choice instead.
 */

/** `picture` is handled separately; legacy formats are archive. */
export const QUESTION_FORMATS = [
  "multiple_choice",
  "open_recall",
  "fill_blank",
  "explain_why",
  "explain_significance",
  "reverse",
] as const;

/** How many words a written answer may run to before it has to be a choice. */
export const MAX_WRITTEN_ANSWER_WORDS = 4;

export function wordCount(value: string): number {
  return value.trim().split(/\s+/).filter(Boolean).length;
}

export interface CadenceSpec {
  writtenCount: number;
  pictureCount: number;
  crossFactMinimum: number;
  /** The floor, not the target: more multiple choice than this is fine. */
  multipleChoiceMinimum: number;
}

export const SPEC: Record<Cadence, CadenceSpec> = {
  // 9 questions + 4 pictures = 13, inside the 10-15 the weekly quiz wants.
  weekly: {
    writtenCount: 9,
    pictureCount: 4,
    crossFactMinimum: 0,
    multipleChoiceMinimum: 7,
  },
  // 15 questions + 5 pictures = 20.
  monthly: {
    writtenCount: 15,
    pictureCount: 5,
    crossFactMinimum: 3,
    multipleChoiceMinimum: 12,
  },
};

/**
 * The picture round can only be as big as the number of facts that actually
 * went out with a picture. When it has to shrink, written questions make up the
 * difference so the quiz stays the length it is supposed to be.
 */
export function specFor(cadence: Cadence, illustratedFacts: number): CadenceSpec {
  const spec = SPEC[cadence];
  const pictureCount = Math.min(spec.pictureCount, illustratedFacts);
  return {
    ...spec,
    pictureCount,
    writtenCount: spec.writtenCount + (spec.pictureCount - pictureCount),
  };
}

export interface GeneratedWritten {
  fact_keys: string[];
  format: (typeof QUESTION_FORMATS)[number];
  prompt: string;
  options: string[];
  correct_answer: string;
  accepted_answers: string[];
  explanation: string;
}

export interface GeneratedPicture {
  fact_key: string;
  prompt: string;
  correct_answer: string;
  accepted_answers: string[];
  explanation: string;
}

export interface GeneratedQuiz {
  questions: GeneratedWritten[];
  pictures: GeneratedPicture[];
}

const ANSWER_PROPS = {
  correct_answer: {
    type: "string",
    description:
      "The expected answer, as briefly as it can be stated. For multiple_choice it must match one of the options word for word. For anything else it must be at most four words — a name, a number, a place — because it has to be typed and matched exactly.",
  },
  accepted_answers: {
    type: "array",
    items: { type: "string" },
    description:
      "Other spellings, shorter forms or equivalent phrasings that should also count, including the blunt way someone would say it out loud. Do not repeat correct_answer.",
  },
  explanation: {
    type: "string",
    description: "One or two sentences explaining the answer, shown after submission.",
  },
} as const;

function schemaFor(factKeys: string[], illustratedKeys: string[]) {
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
            format: { type: "string", enum: [...QUESTION_FORMATS] },
            prompt: { type: "string" },
            options: {
              type: "array",
              items: { type: "string" },
              description:
                "For multiple_choice, exactly four choices, one of which is correct_answer word for word. An empty array for every other format.",
            },
            ...ANSWER_PROPS,
          },
          required: [
            "fact_keys",
            "format",
            "prompt",
            "options",
            "correct_answer",
            "accepted_answers",
            "explanation",
          ],
          additionalProperties: false,
        },
      },
      pictures: {
        type: "array",
        items: {
          type: "object",
          properties: {
            fact_key: {
              type: "string",
              enum: illustratedKeys,
              description:
                "The illustrated fact this question is about. Its picture is what gets shown.",
            },
            prompt: { type: "string" },
            ...ANSWER_PROPS,
          },
          required: [
            "fact_key",
            "prompt",
            "correct_answer",
            "accepted_answers",
            "explanation",
          ],
          additionalProperties: false,
        },
      },
    },
    required: ["questions", "pictures"],
    additionalProperties: false,
  };
}

const SYSTEM = `You set pub quizzes for two people from facts they have already read.
The point is recall — whether the fact stuck — not whether they can guess.

Absolute rules:
- Every question must be answerable from the facts supplied, and must have one
  clear answer a person would either know or not.
- Never give the answer away inside the prompt.

Most questions are multiple choice. A question may only be answered in writing
when the answer is a short name, place or number — at most four words, typed
from memory and matched exactly. Anything longer, and especially any answer that
is a reason or an explanation, must be multiple choice instead. A person who has
the right idea but phrases it differently would otherwise be marked wrong, which
is worse than making the question a little easier.

The formats:
- multiple_choice — four options, exactly one right. Use this for anything whose
  answer is a reason, a cause, an explanation or a phrase.
- open_recall — straight question, answer typed. Short names and numbers only.
- fill_blank — a sentence from the fact with one telling word or number removed,
  written with "____" where the answer goes.
- explain_why — asks for the reason behind something. Must be multiple_choice.
- explain_significance — asks what made it matter. Must be multiple_choice.
- reverse — gives the detail and asks what it belongs to.

Writing the options:
- Exactly four, and only one defensibly right. If two could be argued for, the
  question is wrong.
- The wrong three must be plausible: the same kind of thing as the answer, the
  same sort of length, and drawn from the same world. "It was cheaper" against
  "a badger ate it" gives the game away.
- Do not order them so the answer stands out — it should not always be the
  longest, the most specific or the most reasonable-sounding.
- Never "all of the above", "none of the above", or two options that mean the
  same thing.
- "options" must be empty for every format except multiple_choice.

"accepted_answers" is where you are generous, and it applies to the typed
formats. Include shortened forms, common alternative spellings, with and without
"the", surname alone where a full name is the answer. Anything a reasonable
person might type has to be listed. For multiple_choice it can be empty.

"explanation" is shown only after marking, so it carries the full picture — the
reasoning, the context, the detail the question could not hold.

Picture questions work differently. Each one is built on a fact that went out
with a picture attached, and that same picture is shown above the question — the
players have seen it before, in the briefing, next to the fact. Write the prompt
as though the picture is in front of them: "This is the ____ that ___?" or
"Which ___ is this?". Never name the subject in the prompt if the subject is the
answer — the picture is the clue. Only the facts listed as illustrated can be
used, and each one at most once.

Picture answers are typed, so they follow the same rule as the other typed
formats: a short name, at most four words. Ask one thing, not two.

British spelling throughout.`;

export function illustrated(facts: Fact[]): Fact[] {
  return facts.filter((fact) => Boolean(fact.image_path));
}

function factBrief(facts: Fact[]): string {
  return facts
    .map(
      (fact) =>
        `[${fact.fact_key}] (${fact.topic}, ${fact.publish_date})${fact.image_path ? ` [illustrated: ${fact.image_subject ?? fact.title}]` : ""} ${fact.title}\n  ${fact.key_fact}\n  ${fact.story}`,
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
  illustratedKeys: string[] = factKeys,
): void {
  if (value.questions.length !== spec.writtenCount) {
    throw new Error(
      `expected exactly ${spec.writtenCount} written questions, got ${value.questions.length}`,
    );
  }
  if (value.pictures.length !== spec.pictureCount) {
    throw new Error(
      `expected exactly ${spec.pictureCount} picture questions, got ${value.pictures.length}`,
    );
  }

  const notIllustrated = value.pictures.find(
    (picture) => !illustratedKeys.includes(picture.fact_key),
  );
  if (notIllustrated) {
    throw new Error(
      `picture question uses "${notIllustrated.fact_key}", which has no picture — only the illustrated facts can be used`,
    );
  }

  const pictureKeys = value.pictures.map((picture) => picture.fact_key);
  const duplicate = pictureKeys.find((key, index) => pictureKeys.indexOf(key) !== index);
  if (duplicate) {
    throw new Error(`"${duplicate}" is used for two picture questions; use each once`);
  }

  const notAllowed = value.questions.find(
    (question) => !QUESTION_FORMATS.includes(question.format),
  );
  if (notAllowed) {
    throw new Error(`"${notAllowed.format}" is not one of the allowed formats`);
  }

  const choices = value.questions.filter((q) => q.format === "multiple_choice");
  if (choices.length < spec.multipleChoiceMinimum) {
    throw new Error(
      `only ${choices.length} multiple-choice questions; at least ${spec.multipleChoiceMinimum} of the ${spec.writtenCount} must offer options`,
    );
  }

  for (const question of choices) {
    if (question.options.length !== 4) {
      throw new Error(
        `"${question.prompt}" has ${question.options.length} options; give exactly four`,
      );
    }
    const distinct = new Set(question.options.map((option) => normalise(option)));
    if (distinct.size !== question.options.length) {
      throw new Error(`"${question.prompt}" repeats an option`);
    }
    if (!distinct.has(normalise(question.correct_answer))) {
      throw new Error(
        `"${question.prompt}" has a correct_answer that is not one of its options`,
      );
    }
    const lazy = question.options.find((option) =>
      /^(all|none) of the above$/i.test(option.trim()),
    );
    if (lazy) {
      throw new Error(`"${question.prompt}" uses "${lazy}"; every option must be a real answer`);
    }
  }

  // The whole point of the multiple-choice change: a typed answer has to be
  // something a person can actually type and have matched exactly.
  const typed = [...value.questions, ...value.pictures].filter(
    (q) => !("format" in q) || q.format !== "multiple_choice",
  );
  const wordy = typed.find(
    (q) => wordCount(q.correct_answer) > MAX_WRITTEN_ANSWER_WORDS,
  );
  if (wordy) {
    throw new Error(
      `"${wordy.prompt}" expects "${wordy.correct_answer}" to be typed, which is more than ${MAX_WRITTEN_ANSWER_WORDS} words — make it multiple_choice or ask something shorter`,
    );
  }

  const strayOptions = value.questions.find(
    (q) => q.format !== "multiple_choice" && q.options.length > 0,
  );
  if (strayOptions) {
    throw new Error(`"${strayOptions.prompt}" is ${strayOptions.format} but carries options`);
  }

  const crossFact = value.questions.filter((q) => q.fact_keys.length >= 2).length;
  if (crossFact < spec.crossFactMinimum) {
    throw new Error(
      `only ${crossFact} questions connect two facts; at least ${spec.crossFactMinimum} must`,
    );
  }

  const orphan = value.questions.find((q) => q.fact_keys.length === 0);
  if (orphan) {
    throw new Error(`"${orphan.prompt}" is not attached to any fact`);
  }
  const unknown = value.questions
    .flatMap((q) => q.fact_keys)
    .find((key) => !factKeys.includes(key));
  if (unknown) {
    throw new Error(`fact_keys contains "${unknown}", which is not one of the facts`);
  }
  const leaky = [...value.questions, ...value.pictures].find((q) =>
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
  const withPictures = illustrated(facts);
  const spec = specFor(cadence, withPictures.length);
  const factKeys = facts.map((f) => f.fact_key);
  const illustratedKeys = withPictures.map((f) => f.fact_key);

  const monthlyExtra =
    cadence === "monthly"
      ? `\n\nThis is the monthly quiz, so pitch it harder than a weekly one. Group the
questions loosely by topic rather than scattering them. At least ${spec.crossFactMinimum}
of the written questions must connect two separate facts — give those two entries
in fact_keys.`
      : "";

  const pictureInstruction = spec.pictureCount
    ? `Write exactly ${spec.pictureCount} picture questions, each on a different one of these
illustrated facts:
${illustratedKeys.map((key) => `- ${key}`).join("\n")}`
    : `Write no picture questions — none of these facts went out with a picture.`;

  const prompt = `Facts covered between ${formatLong(periodStart)} and ${formatLong(periodEnd)}:

${factBrief(facts)}

Write exactly ${spec.writtenCount} questions, of which at least
${spec.multipleChoiceMinimum} must be multiple_choice. Leave a question as a typed
answer only where that answer is a short name, place or number.

${pictureInstruction}${monthlyExtra}`;

  return generateJson<GeneratedQuiz>({
    system: SYSTEM,
    prompt,
    schema: schemaFor(factKeys, illustratedKeys) as unknown as Record<string, unknown>,
    effort: "high",
    validate: (value) => validateGeneratedQuiz(value, spec, factKeys, illustratedKeys),
  });
}

export interface ResolvedPicture extends GeneratedPicture {
  image_path: string;
  image_credit: string | null;
}

/**
 * Attach each picture question to the image its fact already carries.
 *
 * Nothing is fetched here any more. The picture round used to resolve its own
 * Wikipedia article at quiz time, which meant the images were guaranteed to be
 * ones nobody had ever seen — an impossible round dressed up as a recall test.
 * Now the only pictures in play are the ones that went out with the briefing.
 */
export function attachPictures(
  candidates: GeneratedPicture[],
  facts: Fact[],
): ResolvedPicture[] {
  const byKey = new Map(facts.map((fact) => [fact.fact_key, fact]));

  return candidates.flatMap((candidate) => {
    const fact = byKey.get(candidate.fact_key);
    if (!fact?.image_path) return [];
    return [
      { ...candidate, image_path: fact.image_path, image_credit: fact.image_credit },
    ];
  });
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
  /** Facts in the period that had a picture to draw on. */
  illustratedFacts: number;
}

export async function publishQuiz(
  cadence: Cadence,
  date: string,
): Promise<PublishResult | null> {
  const db = createAdminClient();
  const { start, end } = periodFor(cadence, date);

  const { data: facts, error: factsError } = await db
    .from("pqb_facts")
    .select("*")
    .gte("publish_date", start)
    .lte("publish_date", end)
    .order("publish_date")
    .order("position");
  if (factsError) throw factsError;

  const withPictures = illustrated(facts ?? []);
  const spec = specFor(cadence, withPictures.length);

  if (!facts || facts.length < spec.writtenCount) {
    // Not enough material — better no quiz than a padded one.
    return null;
  }

  const generated = await generateQuiz(cadence, facts, start, end);
  const pictures = attachPictures(generated.pictures, facts);

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
      options: question.format === "multiple_choice" ? question.options : [],
      correct_answer: question.correct_answer,
      accepted_answers: question.accepted_answers,
      explanation: question.explanation,
      image_path: null,
      image_credit: null,
      position: index + 1,
    })),
    ...pictures.map((picture, index) => ({
      quiz_id: quiz.id,
      fact_key: picture.fact_key,
      format: "picture" as const,
      prompt: picture.prompt,
      options: [],
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
    illustratedFacts: withPictures.length,
  };
}
