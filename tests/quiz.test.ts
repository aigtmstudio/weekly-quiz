import { describe, expect, it } from "vitest";

import {
  MAX_WRITTEN_ANSWER_WORDS,
  QUESTION_FORMATS,
  SPEC,
  attachPictures,
  type GeneratedPicture,
  type GeneratedQuiz,
  type GeneratedWritten,
  illustrated,
  periodFor,
  specFor,
  validateGeneratedQuiz,
} from "@/lib/quiz";
import type { Fact } from "@/lib/types";

const FACT_KEYS = Array.from({ length: 40 }, (_, i) => `fact-${i}`);

/** The first eight facts are the illustrated ones throughout. */
const ILLUSTRATED_KEYS = FACT_KEYS.slice(0, 8);

function fact(key: string, overrides: Partial<Fact> = {}): Fact {
  return {
    id: key,
    fact_key: key,
    publish_date: "2026-08-17",
    position: 1,
    topic: "history",
    title: `Fact ${key}`,
    key_fact: "Something happened.",
    story: "It happened like this. And then this. And finally this.",
    tags: [],
    source: null,
    image_subject: null,
    image_path: null,
    image_credit: null,
    created_at: "2026-08-17T00:00:00Z",
    ...overrides,
  };
}

const FACTS: Fact[] = FACT_KEYS.map((key) =>
  ILLUSTRATED_KEYS.includes(key)
    ? fact(key, {
        image_subject: `Subject ${key}`,
        image_path: `https://blob/${key}.jpg`,
        image_credit: "Wikipedia",
      })
    : fact(key),
);

function written(index: number, overrides: Partial<GeneratedWritten> = {}): GeneratedWritten {
  return {
    fact_keys: [FACT_KEYS[index % FACT_KEYS.length]],
    format: "multiple_choice",
    prompt: `Question number ${index}?`,
    options: [`Answer ${index}`, "Something else", "A third thing", "A fourth"],
    correct_answer: `Answer ${index}`,
    accepted_answers: [],
    explanation: "Because.",
    ...overrides,
  };
}

/** A typed-answer question: short answer, no options. */
function typed(index: number, overrides: Partial<GeneratedWritten> = {}): GeneratedWritten {
  return written(index, {
    format: "open_recall",
    options: [],
    correct_answer: `Answer ${index}`,
    ...overrides,
  });
}

function picture(index: number, overrides: Partial<GeneratedPicture> = {}): GeneratedPicture {
  return {
    fact_key: ILLUSTRATED_KEYS[index % ILLUSTRATED_KEYS.length],
    prompt: `What is shown here, number ${index}?`,
    correct_answer: `Subject ${index}`,
    accepted_answers: [],
    explanation: "Because.",
    ...overrides,
  };
}

function quizFor(cadence: "weekly" | "monthly", spec = SPEC[cadence]): GeneratedQuiz {
  const questions = Array.from({ length: spec.writtenCount }, (_, i) => written(i));

  // Monthly quizzes must join two facts at least three times.
  for (let i = 0; i < spec.crossFactMinimum; i++) {
    questions[i].fact_keys = [FACT_KEYS[i], FACT_KEYS[i + 10]];
  }

  return {
    questions,
    pictures: Array.from({ length: spec.pictureCount }, (_, i) => picture(i)),
  };
}

function validate(quiz: GeneratedQuiz, cadence: "weekly" | "monthly", spec = SPEC[cadence]) {
  validateGeneratedQuiz(quiz, spec, FACT_KEYS, ILLUSTRATED_KEYS);
}

describe("validateGeneratedQuiz", () => {
  it("accepts a well-formed weekly quiz", () => {
    expect(() => validate(quizFor("weekly"), "weekly")).not.toThrow();
  });

  it("accepts a well-formed monthly quiz", () => {
    expect(() =>
      validate(quizFor("monthly"), "monthly"),
    ).not.toThrow();
  });

  it("rejects the wrong number of written questions", () => {
    const quiz = quizFor("weekly");
    quiz.questions.pop();

    expect(() => validate(quiz, "weekly")).toThrow(
      /expected exactly 9 written questions/,
    );
  });

  it("rejects a format that is not one of the allowed ones", () => {
    const quiz = quizFor("weekly");
    quiz.questions[0] = {
      ...quiz.questions[0],
      format: "legacy_multiple_choice" as GeneratedWritten["format"],
    };

    expect(() => validate(quiz, "weekly")).toThrow(
      /not one of the allowed formats/,
    );
  });

  it("requires the monthly quiz to connect facts", () => {
    const quiz = quizFor("monthly");
    quiz.questions = quiz.questions.map((question) => ({
      ...question,
      fact_keys: [question.fact_keys[0]],
    }));

    expect(() => validate(quiz, "monthly")).toThrow(
      /at least 3 must/,
    );
  });

  it("does not demand cross-fact questions of a weekly quiz", () => {
    const quiz = quizFor("weekly");

    expect(() => validate(quiz, "weekly")).not.toThrow();
  });

  it("rejects a question attached to a fact that was not supplied", () => {
    const quiz = quizFor("weekly");
    quiz.questions[0].fact_keys = ["invented-fact"];

    expect(() => validate(quiz, "weekly")).toThrow(
      /not one of the facts/,
    );
  });

  it("rejects a question that gives its own answer away", () => {
    const quiz = quizFor("weekly");
    quiz.questions[0] = {
      ...quiz.questions[0],
      prompt: "Which museum is the Rijksmuseum?",
      options: ["Rijksmuseum", "The Louvre", "The Prado", "The Uffizi"],
      correct_answer: "Rijksmuseum",
    };

    expect(() => validate(quiz, "weekly")).toThrow(
      /contains its own answer/,
    );
  });
});

/**
 * Most questions offer options now. The rule that matters underneath is the one
 * about typing: a question is only left as a typed answer when the answer is
 * short enough to type and match exactly. That is what stops a right-in-
 * substance answer being marked wrong, which is why the change was made.
 */
describe("multiple choice", () => {
  it("insists on enough of them", () => {
    const quiz = quizFor("weekly");
    // Turn all but one into short typed answers.
    quiz.questions = quiz.questions.map((q, i) => (i === 0 ? q : typed(i)));

    expect(() => validate(quiz, "weekly")).toThrow(/at least 7 of the 9 must offer options/);
  });

  it("allows a typed answer when it is a short name or number", () => {
    const quiz = quizFor("weekly");
    quiz.questions[7] = typed(7, { correct_answer: "1969" });
    quiz.questions[8] = typed(8, { correct_answer: "Ada Lovelace" });

    expect(() => validate(quiz, "weekly")).not.toThrow();
  });

  it("refuses to make someone type a whole clause", () => {
    const quiz = quizFor("weekly");
    quiz.questions[8] = typed(8, {
      format: "explain_why",
      correct_answer:
        "Young Tom Morris had won three in a row so kept the belt outright",
    });

    expect(() => validate(quiz, "weekly")).toThrow(/more than 4 words/);
  });

  it("holds picture answers to the same rule", () => {
    const quiz = quizFor("weekly");
    quiz.pictures[0].correct_answer = "The Wollemi pine, found by David Noble";

    expect(() => validate(quiz, "weekly")).toThrow(/more than 4 words/);
  });

  it("wants exactly four options", () => {
    const quiz = quizFor("weekly");
    quiz.questions[0].options = ["One", "Two", "Answer 0"];

    expect(() => validate(quiz, "weekly")).toThrow(/has 3 options/);
  });

  it("rejects a question whose answer is not among its options", () => {
    const quiz = quizFor("weekly");
    quiz.questions[0].correct_answer = "Something not offered";

    expect(() => validate(quiz, "weekly")).toThrow(/not one of its options/);
  });

  it("rejects a repeated option, however it is spelled", () => {
    const quiz = quizFor("weekly");
    quiz.questions[0].options = ["Answer 0", "answer 0!", "A third thing", "A fourth"];

    expect(() => validate(quiz, "weekly")).toThrow(/repeats an option/);
  });

  it("rejects all of the above", () => {
    const quiz = quizFor("weekly");
    quiz.questions[0].options = ["Answer 0", "Two", "Three", "All of the above"];

    expect(() => validate(quiz, "weekly")).toThrow(/every option must be a real answer/);
  });

  it("does not let a typed question carry options", () => {
    const quiz = quizFor("weekly");
    quiz.questions[8] = typed(8, { options: ["a", "b", "c", "d"] });

    expect(() => validate(quiz, "weekly")).toThrow(/carries options/);
  });

  it("keeps every format in the allowed set", () => {
    expect(QUESTION_FORMATS).toContain("multiple_choice");
    expect(QUESTION_FORMATS).not.toContain("picture");
    expect(MAX_WRITTEN_ANSWER_WORDS).toBe(4);
  });
});

describe("the picture round draws only on facts that were sent with a picture", () => {
  it("rejects a picture question about a fact that had no image", () => {
    const quiz = quizFor("weekly");
    quiz.pictures[0].fact_key = "fact-30";

    expect(() => validate(quiz, "weekly")).toThrow(/only the illustrated facts/);
  });

  it("rejects the same picture being used twice", () => {
    const quiz = quizFor("weekly");
    quiz.pictures[1].fact_key = quiz.pictures[0].fact_key;

    expect(() => validate(quiz, "weekly")).toThrow(/two picture questions/);
  });

  it("shows each question the picture its own fact carried", () => {
    const attached = attachPictures(quizFor("weekly").pictures, FACTS);

    expect(attached).toHaveLength(SPEC.weekly.pictureCount);
    for (const resolved of attached) {
      expect(resolved.image_path).toBe(`https://blob/${resolved.fact_key}.jpg`);
      expect(resolved.image_credit).toBe("Wikipedia");
    }
  });

  it("drops a question rather than showing a picture that is not there", () => {
    const attached = attachPictures([picture(0), picture(0, { fact_key: "fact-30" })], FACTS);

    expect(attached.map((p) => p.fact_key)).toEqual([ILLUSTRATED_KEYS[0]]);
  });

  it("counts only the facts that have an image", () => {
    expect(illustrated(FACTS)).toHaveLength(ILLUSTRATED_KEYS.length);
  });
});

describe("specFor", () => {
  it("keeps the quiz the same length when there are too few pictures", () => {
    const spec = specFor("weekly", 1);

    expect(spec.pictureCount).toBe(1);
    expect(spec.writtenCount + spec.pictureCount).toBe(
      SPEC.weekly.writtenCount + SPEC.weekly.pictureCount,
    );
  });

  it("drops the picture round entirely when no fact had an image", () => {
    const spec = specFor("monthly", 0);

    expect(spec.pictureCount).toBe(0);
    expect(spec.writtenCount).toBe(20);
    expect(() => validate(quizFor("monthly", spec), "monthly", spec)).not.toThrow();
  });

  it("never asks for more pictures than the cadence wants", () => {
    expect(specFor("weekly", 30).pictureCount).toBe(SPEC.weekly.pictureCount);
  });
});

describe("periodFor", () => {
  it("covers the seven days before a Monday run", () => {
    expect(periodFor("weekly", "2026-08-10")).toEqual({
      start: "2026-08-03",
      end: "2026-08-09",
    });
  });

  it("covers the whole previous month on the 1st", () => {
    expect(periodFor("monthly", "2026-08-01")).toEqual({
      start: "2026-07-01",
      end: "2026-07-31",
    });
  });

  it("handles the turn of the year", () => {
    expect(periodFor("monthly", "2027-01-01")).toEqual({
      start: "2026-12-01",
      end: "2026-12-31",
    });
  });
});
