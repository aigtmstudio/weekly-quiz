import { formatLong, formatShort } from "@/lib/dates";
import type { Cadence, Fact, Question } from "@/lib/types";

/**
 * Email bodies.
 *
 * Deliberately plain HTML with inline styles — this is read by two people in
 * Gmail, not a marketing list, and a stack of nested tables would earn nothing.
 *
 * Images are referenced by content ID and attached by the sender. Gmail does
 * not reliably render `data:` URIs, so the base64 approach that works on the
 * web must not be carried into email.
 */

export interface ReferencedImage {
  cid: string;
  url: string;
  filename: string;
}

export interface EmailBody {
  subject: string;
  html: string;
  text: string;
  images: ReferencedImage[];
}

const BODY_STYLE =
  "margin:0;padding:24px 16px;background:#fbfaf7;color:#1b1a17;font-family:Georgia,'Times New Roman',serif;font-size:17px;line-height:1.55;";
const WRAP_STYLE = "max-width:600px;margin:0 auto;";
const CARD_STYLE =
  "background:#ffffff;border:1px solid #e5e1d8;border-radius:8px;padding:18px 20px;margin:0 0 16px;";
const LABEL_STYLE =
  "font-family:Helvetica,Arial,sans-serif;font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#6c6862;margin:0 0 6px;";
const MUTED_STYLE = "color:#6c6862;margin:10px 0 0;";
const LINK_STYLE = "color:#8a4b2a;";

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function shell(inner: string, footer: string): string {
  return `<div style="${BODY_STYLE}"><div style="${WRAP_STYLE}">${inner}${footer}</div></div>`;
}

function footerHtml(siteUrl: string, unsubscribeUrl: string): string {
  return `<p style="font-family:Helvetica,Arial,sans-serif;font-size:12px;color:#6c6862;margin:24px 0 0;">
<a href="${escapeHtml(siteUrl)}" style="${LINK_STYLE}">Read on the site</a> ·
<a href="${escapeHtml(unsubscribeUrl)}" style="${LINK_STYLE}">Unsubscribe</a>
</p>`;
}

const IMG_STYLE =
  "display:block;max-width:100%;height:auto;border:1px solid #e5e1d8;border-radius:6px;margin:0 0 10px;";
const CREDIT_STYLE =
  "font-family:Helvetica,Arial,sans-serif;font-size:11px;color:#6c6862;margin:0 0 12px;";

/**
 * The picture is the whole point of the fact carrying one: the quiz's picture
 * round is built from these, so if it does not appear in the briefing the round
 * is unanswerable. `images` is appended to, and the sender attaches each one by
 * content ID.
 */
function factHtml(fact: Fact, images: ReferencedImage[]): string {
  let imageHtml = "";
  if (fact.image_path) {
    const cid = `f${images.length + 1}`;
    images.push({ cid, url: fact.image_path, filename: `${cid}.jpg` });
    imageHtml = `<img src="cid:${cid}" width="420" alt="${escapeHtml(fact.image_subject ?? fact.title)}" style="${IMG_STYLE}" />${
      fact.image_credit
        ? `<p style="${CREDIT_STYLE}">${escapeHtml(fact.image_credit)}</p>`
        : ""
    }`;
  }

  return `<div style="${CARD_STYLE}">
<p style="${LABEL_STYLE}">${escapeHtml(fact.topic)}</p>
<h2 style="font-size:19px;margin:0 0 8px;">${escapeHtml(fact.title)}</h2>
${imageHtml}<p style="margin:0;">${escapeHtml(fact.key_fact)}</p>
<p style="${MUTED_STYLE}">${escapeHtml(fact.story)}</p>
</div>`;
}

function factText(fact: Fact): string {
  return `${fact.topic.toUpperCase()}\n${fact.title}\n${fact.key_fact}\n${fact.story}\n`;
}

export interface DailyEmailInput {
  date: string;
  facts: Fact[];
  repeats: Fact[];
  siteUrl: string;
  unsubscribeUrl: string;
}

export function dailyEmail({
  date,
  facts,
  repeats,
  siteUrl,
  unsubscribeUrl,
}: DailyEmailInput): EmailBody {
  const images: ReferencedImage[] = [];

  const factSection = facts.map((fact) => factHtml(fact, images)).join("");
  const repeatSection = repeats.length
    ? `<h2 style="font-size:15px;font-family:Helvetica,Arial,sans-serif;letter-spacing:.08em;text-transform:uppercase;color:#6c6862;margin:28px 0 12px;">Worth another look</h2>${repeats
        .map((fact) => factHtml(fact, images))
        .join("")}`
    : "";

  const html = shell(
    `<h1 style="font-size:24px;margin:0 0 20px;">${escapeHtml(formatLong(date))}</h1>${factSection}${repeatSection}`,
    footerHtml(siteUrl, unsubscribeUrl),
  );

  const text = [
    formatLong(date),
    "",
    ...facts.map(factText),
    ...(repeats.length ? ["WORTH ANOTHER LOOK", "", ...repeats.map(factText)] : []),
    `Read on the site: ${siteUrl}`,
    `Unsubscribe: ${unsubscribeUrl}`,
  ].join("\n");

  return {
    subject: `${facts.length} facts — ${formatShort(date)}`,
    html,
    text,
    images,
  };
}

export interface QuizEmailInput {
  cadence: Cadence;
  periodStart: string;
  periodEnd: string;
  questions: Question[];
  quizUrl: string;
  siteUrl: string;
  unsubscribeUrl: string;
}

/**
 * The quiz email carries the whole quiz: questions, a divider, then answers
 * with explanations. It is readable without clicking anything — the link to the
 * site is for a scored attempt, not for the content.
 */
export function quizEmail({
  cadence,
  periodStart,
  periodEnd,
  questions,
  quizUrl,
  siteUrl,
  unsubscribeUrl,
}: QuizEmailInput): EmailBody {
  const images: ReferencedImage[] = [];

  const questionBlocks = questions
    .map((question, index) => {
      let imageHtml = "";
      if (question.image_path) {
        const cid = `q${index + 1}`;
        images.push({
          cid,
          url: question.image_path,
          filename: `${cid}.jpg`,
        });
        imageHtml = `<img src="cid:${cid}" width="420" alt="" style="display:block;max-width:100%;height:auto;border:1px solid #e5e1d8;border-radius:6px;margin:0 0 12px;" />${
          question.image_credit
            ? `<p style="font-family:Helvetica,Arial,sans-serif;font-size:11px;color:#6c6862;margin:0 0 10px;">${escapeHtml(question.image_credit)}</p>`
            : ""
        }`;
      }
      return `<div style="${CARD_STYLE}"><p style="${LABEL_STYLE}">Question ${index + 1}</p>${imageHtml}<p style="margin:0;">${escapeHtml(question.prompt)}</p></div>`;
    })
    .join("");

  const answerBlocks = questions
    .map(
      (question, index) =>
        `<div style="margin:0 0 14px;"><p style="${LABEL_STYLE}">Answer ${index + 1}</p><p style="margin:0;"><strong>${escapeHtml(question.correct_answer)}</strong></p>${
          question.explanation
            ? `<p style="${MUTED_STYLE}">${escapeHtml(question.explanation)}</p>`
            : ""
        }</div>`,
    )
    .join("");

  const title = `${cadence === "weekly" ? "Weekly" : "Monthly"} quiz`;

  const html = shell(
    `<h1 style="font-size:24px;margin:0 0 4px;">${title}</h1>
<p style="font-family:Helvetica,Arial,sans-serif;font-size:13px;color:#6c6862;margin:0 0 20px;">Facts from ${escapeHtml(formatShort(periodStart))} to ${escapeHtml(formatShort(periodEnd))} · ${questions.length} questions</p>
${questionBlocks}
<p style="margin:20px 0;"><a href="${escapeHtml(quizUrl)}" style="${LINK_STYLE}">Take it scored on the site →</a></p>
<hr style="border:none;border-top:2px solid #e5e1d8;margin:32px 0;" />
<h2 style="font-size:19px;margin:0 0 16px;">Answers</h2>
${answerBlocks}`,
    footerHtml(siteUrl, unsubscribeUrl),
  );

  const text = [
    title,
    `Facts from ${formatShort(periodStart)} to ${formatShort(periodEnd)}`,
    "",
    ...questions.map((q, i) => `${i + 1}. ${q.prompt}`),
    "",
    `Take it scored: ${quizUrl}`,
    "",
    "--- ANSWERS ---",
    "",
    ...questions.map(
      (q, i) => `${i + 1}. ${q.correct_answer}${q.explanation ? `\n   ${q.explanation}` : ""}`,
    ),
    "",
    `Unsubscribe: ${unsubscribeUrl}`,
  ].join("\n");

  return {
    subject: `${title} — ${formatShort(periodEnd)}`,
    html,
    text,
    images,
  };
}
