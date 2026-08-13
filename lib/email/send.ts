import { Resend } from "resend";

import { serverEnv } from "@/lib/env";
import type { EmailBody, ReferencedImage } from "@/lib/email/templates";

let cached: Resend | null = null;

function client() {
  if (!cached) cached = new Resend(serverEnv.resendApiKey);
  return cached;
}

/**
 * Fetch the images the body references and turn them into inline attachments.
 * A picture that won't download is dropped rather than blocking the send — the
 * question text still reads.
 */
async function buildAttachments(images: ReferencedImage[]) {
  const attachments = await Promise.all(
    images.map(async (image) => {
      try {
        const response = await fetch(image.url);
        if (!response.ok) return null;
        return {
          filename: image.filename,
          content: Buffer.from(await response.arrayBuffer()),
          contentId: image.cid,
          contentType: response.headers.get("content-type") ?? undefined,
        };
      } catch {
        return null;
      }
    }),
  );
  return attachments.filter((attachment) => attachment !== null);
}

export interface SendResult {
  id: string | null;
}

export async function sendEmail(
  to: string,
  body: EmailBody,
  unsubscribeUrl: string,
): Promise<SendResult> {
  const attachments = await buildAttachments(body.images);

  const { data, error } = await client().emails.send({
    from: serverEnv.emailFrom,
    to,
    subject: body.subject,
    html: body.html,
    text: body.text,
    ...(attachments.length ? { attachments } : {}),
    headers: {
      // One-click unsubscribe, honoured by the mail client itself.
      "List-Unsubscribe": `<${unsubscribeUrl}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  });

  if (error) throw new Error(`Resend refused the message: ${error.message}`);
  return { id: data?.id ?? null };
}
