import { describe, expect, it, vi } from "vitest";

import { ImageError } from "@/lib/images";
import {
  MIN_PICTURES,
  SPEC,
  WRITTEN_FORMATS,
  type GeneratedPicture,
  type GeneratedQuiz,
  type GeneratedWritten,
  periodFor,
  resolvePictures,
  validateGeneratedQuiz,
} from "@/lib/quiz";

const FACT_KEYS = Array.from({ length: 40 }, (_, i) => `fact-${i}`);

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
    fact_keys: [FACT_KEYS[index % FACT_KEYS.length]],
    wikipedia_article: `Article ${index}`,
    prompt: `What is shown here, number ${index}?`,
    correct_answer: `Subject ${index}`,
    accepted_answers: [],
    explanation: "Because.",
    ...overrides,
  };
}

function quizFor(cadence: "weekly" | "monthly"): GeneratedQuiz {
  const spec = SPEC[cadence];
  const questions = Array.from({ length: spec.writtenCount }, (_, i) => written(i));

  // Monthly quizzes must join two facts at least three times.
  for (let i = 0; i < spec.crossFactMinimum; i++) {
    questions[i].fact_keys = [FACT_KEYS[i], FACT_KEYS[i + 10]];
  }

  return {
    questions,
    picture_candidates: Array.from({ length: spec.pictureCandidates }, (_, i) => picture(i)),
  };
}

describe("validateGeneratedQuiz", () => {
  it("accepts a well-formed weekly quiz", () => {
    expect(() => validateGeneratedQuiz(quizFor("weekly"), SPEC.weekly, FACT_KEYS)).not.toThrow();
  });

  it("accepts a well-formed monthly quiz", () => {
    expect(() =>
      validateGeneratedQuiz(quizFor("monthly"), SPEC.monthly, FACT_KEYS),
    ).not.toThrow();
  });

  it("rejects the wrong number of written questions", () => {
    const quiz = quizFor("weekly");
    quiz.questions.pop();

    expect(() => validateGeneratedQuiz(quiz, SPEC.weekly, FACT_KEYS)).toThrow(
      /expected exactly 9 written questions/,
    );
  });

  it("rejects multiple choice, whatever it is labelled", () => {
    const quiz = quizFor("weekly");
    quiz.questions[0] = {
      ...quiz.questions[0],
      format: "legacy_multiple_choice" as GeneratedWritten["format"],
    };

    expect(() => validateGeneratedQuiz(quiz, SPEC.weekly, FACT_KEYS)).toThrow(
      /not one of the allowed formats/,
    );
  });

  it("rejects a quiz that leans on one or two formats", () => {
    const quiz = quizFor("weekly");
    quiz.questions = quiz.questions.map((question) => ({
      ...question,
      format: "open_recall",
    }));

    expect(() => validateGeneratedQuiz(quiz, SPEC.weekly, FACT_KEYS)).toThrow(
      /at least four of the five/,
    );
  });

  it("requires the monthly quiz to connect facts", () => {
    const quiz = quizFor("monthly");
    quiz.questions = quiz.questions.map((question) => ({
      ...question,
      fact_keys: [question.fact_keys[0]],
    }));

    expect(() => validateGeneratedQuiz(quiz, SPEC.monthly, FACT_KEYS)).toThrow(
      /at least 3 must/,
    );
  });

  it("does not demand cross-fact questions of a weekly quiz", () => {
    const quiz = quizFor("weekly");

    expect(() => validateGeneratedQuiz(quiz, SPEC.weekly, FACT_KEYS)).not.toThrow();
  });

  it("rejects a question attached to a fact that was not supplied", () => {
    const quiz = quizFor("weekly");
    quiz.questions[0].fact_keys = ["invented-fact"];

    expect(() => validateGeneratedQuiz(quiz, SPEC.weekly, FACT_KEYS)).toThrow(
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

    expect(() => validateGeneratedQuiz(quiz, SPEC.weekly, FACT_KEYS)).toThrow(
      /contains its own answer/,
    );
  });
});

describe("resolvePictures", () => {
  const candidates = Array.from({ length: 7 }, (_, i) => picture(i));

  function store(failing: Set<string>) {
    return vi.fn(async (article: string) => {
      if (failing.has(article)) {
        throw new ImageError(`"${article}" has no lead image`);
      }
      return { imagePath: `https://blob/${article}.jpg`, imageCredit: "Wikipedia" };
    });
  }

  it("stops once it has the target number", async () => {
    const stored = store(new Set());
    const { pictures, skipped } = await resolvePictures(candidates, 4, stored);

    expect(pictures).toHaveLength(4);
    expect(skipped).toEqual([]);
    // Doesn't download images it isn't going to use.
    expect(stored).toHaveBeenCalledTimes(4);
  });

  it("skips a subject with no lead image and moves to the next", async () => {
    const stored = store(new Set(["Article 0", "Article 2"]));
    const { pictures, skipped } = await resolvePictures(candidates, 4, stored);

    expect(pictures).toHaveLength(4);
    expect(pictures.map((p) => p.wikipedia_article)).not.toContain("Article 0");
    expect(skipped).toHaveLength(2);
  });

  it("never substitutes a different subject's image", async () => {
    const stored = store(new Set());
    const { pictures } = await resolvePictures(candidates, 4, stored);

    for (const resolved of pictures) {
      expect(resolved.image_path).toBe(`https://blob/${resolved.wikipedia_article}.jpg`);
    }
  });

  it("returns a short round rather than failing when too many subjects fail", async () => {
    const stored = store(new Set(candidates.slice(0, 5).map((c) => c.wikipedia_article)));
    const { pictures, skipped } = await resolvePictures(candidates, 4, stored);

    expect(pictures).toHaveLength(2);
    expect(pictures.length).toBeLessThan(MIN_PICTURES);
    expect(skipped).toHaveLength(5);
  });

  it("lets an unexpected error through instead of silently dropping the picture", async () => {
    const stored = vi.fn(async () => {
      throw new TypeError("blob store misconfigured");
    });

    await expect(resolvePictures(candidates, 4, stored)).rejects.toThrow(TypeError);
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
