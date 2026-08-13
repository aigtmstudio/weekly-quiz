"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import type { PublicQuestion } from "@/lib/types";

const SAVE_DELAY_MS = 1500;

export function QuizForm({
  quizId,
  questions,
  initialResponses,
}: {
  quizId: string;
  questions: PublicQuestion[];
  initialResponses: Record<string, string>;
}) {
  const router = useRouter();
  const [responses, setResponses] = useState(initialResponses);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const dirty = useRef(false);

  // Autosave, so a half-finished quiz survives closing the tab.
  useEffect(() => {
    if (!dirty.current) return;
    const timer = setTimeout(() => {
      void fetch(`/api/quiz/${quizId}/progress`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ responses }),
      })
        .then(() => setSaved(true))
        .catch(() => {});
    }, SAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [responses, quizId]);

  const update = useCallback((questionId: string, value: string) => {
    dirty.current = true;
    setSaved(false);
    setResponses((current) => ({ ...current, [questionId]: value }));
  }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    const response = await fetch(`/api/quiz/${quizId}/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ responses }),
    });

    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      setError(body.error ?? "Something went wrong submitting that.");
      setSubmitting(false);
      return;
    }

    router.replace(`/quiz/${quizId}/result`);
    router.refresh();
  }

  const answered = questions.filter((q) => (responses[q.id] ?? "").trim()).length;

  return (
    <form onSubmit={submit} className="flex flex-col gap-6">
      {questions.map((question, index) => (
        <fieldset
          key={question.id}
          className="rounded-lg border border-line bg-surface p-5"
        >
          <legend className="px-1 text-xs uppercase tracking-widest text-muted">
            {index + 1} of {questions.length}
          </legend>

          {question.image_path && (
            <figure className="mb-4">
              <Image
                src={question.image_path}
                alt=""
                width={420}
                height={315}
                unoptimized
                className="h-auto w-full max-w-md rounded-md border border-line"
              />
              {question.image_credit && (
                <figcaption className="mt-1 text-xs text-muted">
                  {question.image_credit}
                </figcaption>
              )}
            </figure>
          )}

          <label htmlFor={question.id} className="block font-serif text-lg leading-snug">
            {question.prompt}
          </label>
          <input
            id={question.id}
            name={question.id}
            type="text"
            autoComplete="off"
            value={responses[question.id] ?? ""}
            onChange={(event) => update(question.id, event.target.value)}
            className="mt-3 w-full rounded-md border border-line bg-background px-3 py-2 outline-none focus:border-accent"
          />
        </fieldset>
      ))}

      {error && <p className="text-sm text-wrong">{error}</p>}

      <div className="flex items-center gap-4">
        <button
          type="submit"
          disabled={submitting}
          className="rounded-md bg-accent px-5 py-2 font-medium text-background disabled:opacity-60"
        >
          {submitting ? "Marking…" : "Submit answers"}
        </button>
        <span className="text-sm text-muted">
          {answered} of {questions.length} answered
          {saved && " · progress saved"}
        </span>
      </div>
      <p className="text-xs text-muted">
        Anything left blank counts as wrong. You only get one go at each quiz.
      </p>
    </form>
  );
}
