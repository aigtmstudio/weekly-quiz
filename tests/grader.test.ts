import { describe, expect, it } from "vitest";

import { gradeAttempt, isCorrect, normalise } from "@/lib/grader";

const question = {
  id: "q1",
  correct_answer: "The Rijksmuseum",
  accepted_answers: ["Rijks Museum"],
};

describe("normalise", () => {
  it("ignores case, spacing and punctuation", () => {
    expect(normalise("  The RIJKS-museum!  ")).toBe(normalise("the rijks museum"));
  });

  it("ignores accents", () => {
    expect(normalise("Émile Zola")).toBe(normalise("Emile Zola"));
  });

  it("ignores thousands separators in numbers", () => {
    expect(normalise("1,000,000")).toBe("1000000");
  });
});

describe("isCorrect", () => {
  it("accepts the answer whatever the case and spacing", () => {
    expect(isCorrect("  the rijksmuseum ", question)).toBe(true);
    expect(isCorrect("THE RIJKSMUSEUM", question)).toBe(true);
  });

  it("accepts an alternative spelling from accepted_answers", () => {
    expect(isCorrect("rijks museum", question)).toBe(true);
  });

  it("accepts the answer with or without a leading article", () => {
    expect(isCorrect("Rijksmuseum", question)).toBe(true);
  });

  it("rejects a wrong answer", () => {
    expect(isCorrect("The Louvre", question)).toBe(false);
  });

  it("treats blank and missing answers as wrong, not as skipped", () => {
    expect(isCorrect("", question)).toBe(false);
    expect(isCorrect("   ", question)).toBe(false);
    expect(isCorrect(undefined, question)).toBe(false);
    expect(isCorrect(null, question)).toBe(false);
  });
});

describe("gradeAttempt", () => {
  const questions = [
    question,
    { id: "q2", correct_answer: "1969", accepted_answers: [] },
    { id: "q3", correct_answer: "Ada Lovelace", accepted_answers: ["Lovelace"] },
  ];

  it("scores what was answered and records what was not", () => {
    const result = gradeAttempt(questions, { q1: "rijksmuseum", q2: "1971" });

    expect(result.score).toBe(1);
    expect(result.total).toBe(3);
    expect(result.answers).toHaveLength(3);

    // An unanswered question is still recorded, so the scheduler sees it.
    const unanswered = result.answers.find((a) => a.question_id === "q3");
    expect(unanswered).toEqual({ question_id: "q3", response: "", is_correct: false });
  });

  it("ignores responses for questions that are not in the quiz", () => {
    const result = gradeAttempt(questions, { q1: "rijksmuseum", nonsense: "hello" });

    expect(result.answers.map((a) => a.question_id)).toEqual(["q1", "q2", "q3"]);
  });

  it("gives full marks when everything is right", () => {
    const result = gradeAttempt(questions, {
      q1: "The Rijksmuseum",
      q2: "1969",
      q3: "lovelace",
    });

    expect(result.score).toBe(3);
  });
});
