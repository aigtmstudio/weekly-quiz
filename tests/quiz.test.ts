import { describe, expect, it } from "vitest";

import {
  SPEC,
  WRITTEN_FORMATS,
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
    format: WRITTEN_FORMATS[index % WRITTEN_FORMATS.length],
    prompt: `Question number ${index}?`,
    correct_answer: `Answer ${index}`,
    accepted_answers: [],
    explanation: "Because.",
    ...overrides,
  };
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

  it("rejects multiple choice, whatever it is labelled", () => {
    const quiz = quizFor("weekly");
    quiz.questions[0] = {
      ...quiz.questions[0],
      format: "legacy_multiple_choice" as GeneratedWritten["format"],
    };

    expect(() => validate(quiz, "weekly")).toThrow(
      /not one of the allowed formats/,
    );
  });

  it("rejects a quiz that leans on one or two formats", () => {
    const quiz = quizFor("weekly");
    quiz.questions = quiz.questions.map((question) => ({
      ...question,
      format: "open_recall",
    }));

    expect(() => validate(quiz, "weekly")).toThrow(
      /at least four of the five/,
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
      correct_answer: "Rijksmuseum",
    };

    expect(() => validate(quiz, "weekly")).toThrow(
      /contains its own answer/,
    );
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
