import { describe, expect, it } from "vitest";

import {
  applyVerdicts,
  gradeAttempt,
  isCorrect,
  needsReview,
  normalise,
} from "@/lib/grader";

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

/**
 * Exact matching cannot mark an "explain why" answer, so those go to a second
 * pass. These cover the merge, not the model — the judgement itself is the
 * model's, but the rules about what it is allowed to change are ours.
 */
describe("second-pass marking", () => {
  const questions = [
    { id: "q1", correct_answer: "1969", accepted_answers: [] },
    {
      id: "q2",
      correct_answer:
        "Young Tom Morris had won three in a row so kept the Challenge Belt outright, leaving no trophy to play for",
      accepted_answers: [],
    },
    { id: "q3", correct_answer: "Ada Lovelace", accepted_answers: [] },
  ];

  it("sends the wrong-but-attempted answers for review", () => {
    const graded = gradeAttempt(questions, {
      q1: "1969",
      q2: "because there was no trophy",
      q3: "",
    });

    // q1 was right, q3 was blank — neither is worth an API call.
    expect(needsReview(graded).map((a) => a.question_id)).toEqual(["q2"]);
  });

  it("never sends a blank answer for review", () => {
    const graded = gradeAttempt(questions, { q1: "", q2: "   ", q3: "" });

    expect(needsReview(graded)).toEqual([]);
  });

  it("rescues an answer that got the substance right", () => {
    const graded = gradeAttempt(questions, { q2: "because there was no trophy" });
    const marked = applyVerdicts(graded, [{ question_id: "q2", is_correct: true }]);

    expect(marked.answers.find((a) => a.question_id === "q2")?.is_correct).toBe(true);
    expect(marked.score).toBe(1);
  });

  it("leaves an answer wrong when the second pass agrees it is wrong", () => {
    const graded = gradeAttempt(questions, { q2: "the edges were chipped" });
    const marked = applyVerdicts(graded, [{ question_id: "q2", is_correct: false }]);

    expect(marked.answers.find((a) => a.question_id === "q2")?.is_correct).toBe(false);
    expect(marked.score).toBe(0);
  });

  it("cannot take away a mark the exact match already gave", () => {
    const graded = gradeAttempt(questions, { q1: "1969" });
    const marked = applyVerdicts(graded, [{ question_id: "q1", is_correct: false }]);

    expect(marked.answers.find((a) => a.question_id === "q1")?.is_correct).toBe(true);
    expect(marked.score).toBe(1);
  });

  it("keeps the exact-match score when the second pass fails entirely", () => {
    // markFreeText returns [] on any error, so this is the outage path.
    const graded = gradeAttempt(questions, { q1: "1969", q2: "no trophy" });

    expect(applyVerdicts(graded, [])).toEqual(graded);
  });

  it("recounts the score rather than trusting the old one", () => {
    const graded = gradeAttempt(questions, {
      q1: "1969",
      q2: "no trophy to play for",
      q3: "ada lovelace",
    });
    expect(graded.score).toBe(2);

    const marked = applyVerdicts(graded, [{ question_id: "q2", is_correct: true }]);
    expect(marked.score).toBe(3);
    expect(marked.total).toBe(3);
  });

  it("ignores a verdict for a question that was not under review", () => {
    const graded = gradeAttempt(questions, { q1: "1969" });
    const marked = applyVerdicts(graded, [{ question_id: "nonsense", is_correct: true }]);

    expect(marked.score).toBe(graded.score);
  });
});
