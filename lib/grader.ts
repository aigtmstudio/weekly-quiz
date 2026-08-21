import type { Question } from "@/lib/types";

/**
 * Grading, which lives on the server.
 *
 * The old build shipped the answers to the browser so it could mark itself,
 * which meant anyone could read them before answering. Nothing here is ever
 * sent to a client before an attempt is submitted.
 */

const LEADING_ARTICLE = /^(the|a|an)\s+/;

/**
 * Reduce an answer to the part worth comparing: case, punctuation, accents,
 * thousands separators and a leading article are all noise.
 */
export function normalise(value: string): string {
  const cleaned = value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[‘’“”]/g, "'")
    .replace(/(\d),(?=\d{3}\b)/g, "$1")
    .replace(/[^\p{Letter}\p{Number}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

  return cleaned.replace(LEADING_ARTICLE, "");
}

/** Every string that should count as correct for a question. */
export function acceptedFor(question: Pick<Question, "correct_answer" | "accepted_answers">) {
  return [question.correct_answer, ...question.accepted_answers]
    .map(normalise)
    .filter((value) => value.length > 0);
}

export function isCorrect(
  response: string | undefined | null,
  question: Pick<Question, "correct_answer" | "accepted_answers">,
): boolean {
  // An unanswered question is wrong, not skipped.
  if (response == null) return false;
  const given = normalise(response);
  if (!given) return false;
  return acceptedFor(question).includes(given);
}

export interface GradedAnswer {
  question_id: string;
  response: string;
  is_correct: boolean;
}

export interface GradedAttempt {
  score: number;
  total: number;
  answers: GradedAnswer[];
}

/**
 * Which answers are worth a second look by the marker.
 *
 * Only ones exact matching rejected, and only where the person actually wrote
 * something — a blank is wrong on its own terms and never worth an API call.
 */
export function needsReview(graded: GradedAttempt): GradedAnswer[] {
  return graded.answers.filter(
    (answer) => !answer.is_correct && answer.response.trim().length > 0,
  );
}

/**
 * Fold the marker's verdicts back in.
 *
 * Upgrades only: a verdict can rescue a wrong answer but can never overturn one
 * the exact match already accepted, so the deterministic pass stays the floor.
 */
export function applyVerdicts(
  graded: GradedAttempt,
  verdicts: Array<{ question_id: string; is_correct: boolean }>,
): GradedAttempt {
  const rescued = new Set(
    verdicts.filter((verdict) => verdict.is_correct).map((v) => v.question_id),
  );

  const answers = graded.answers.map((answer) =>
    answer.is_correct || !rescued.has(answer.question_id)
      ? answer
      : { ...answer, is_correct: true },
  );

  return {
    ...graded,
    answers,
    score: answers.filter((answer) => answer.is_correct).length,
  };
}

/**
 * Grade a whole attempt. `responses` is keyed by question id; questions with no
 * entry are marked wrong and still recorded, so the repetition scheduler sees
 * them.
 */
export function gradeAttempt(
  questions: Array<Pick<Question, "id" | "correct_answer" | "accepted_answers">>,
  responses: Record<string, string>,
): GradedAttempt {
  const answers = questions.map((question) => {
    const response = responses[question.id] ?? "";
    return {
      question_id: question.id,
      response: response.trim(),
      is_correct: isCorrect(response, question),
    };
  });

  return {
    score: answers.filter((answer) => answer.is_correct).length,
    total: questions.length,
    answers,
  };
}
