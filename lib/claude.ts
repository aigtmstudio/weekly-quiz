import Anthropic from "@anthropic-ai/sdk";

import { serverEnv } from "@/lib/env";

export const MODEL = "claude-opus-5";

/**
 * Thinking is on by default on Opus 5 and `max_tokens` caps thinking *plus*
 * output, so this needs headroom well above the visible answer length.
 */
const MAX_TOKENS = 16000;

let cached: Anthropic | null = null;

function client() {
  if (!cached) {
    cached = new Anthropic({
      apiKey: serverEnv.anthropicApiKey,
      // Vercel functions get 300s; leave room to surface a clean error first.
      timeout: 280_000,
      maxRetries: 3,
    });
  }
  return cached;
}

export type Effort = "low" | "medium" | "high";

export class GenerationError extends Error {}

export interface GenerateJsonOptions<T> {
  system: string;
  prompt: string;
  /** JSON Schema. Every object in it needs `additionalProperties: false`. */
  schema: Record<string, unknown>;
  effort?: Effort;
  /**
   * Structured outputs ignore `minItems` / `maxItems` / `minLength`, so any
   * count or length requirement has to be checked here. Throw a message
   * describing the problem — it is fed back to the model on the single retry.
   */
  validate?: (value: T) => void;
}

/**
 * One structured-output call, with a single corrective retry.
 *
 * Requests stream and then resolve via `finalMessage()`: nothing here consumes
 * partial output, but streaming avoids request timeouts on long generations.
 */
export async function generateJson<T>({
  system,
  prompt,
  schema,
  effort = "medium",
  validate,
}: GenerateJsonOptions<T>): Promise<T> {
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: prompt }];

  for (let attempt = 0; attempt < 2; attempt++) {
    const stream = client().messages.stream({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system,
      messages,
      // No temperature / top_p / top_k — Opus 5 rejects them with a 400.
      output_config: {
        effort,
        format: { type: "json_schema", schema },
      },
    });

    const message = await stream.finalMessage();

    if (message.stop_reason === "refusal") {
      throw new GenerationError("Claude declined to produce this content");
    }

    const text = message.content.find((block) => block.type === "text")?.text;
    if (!text) {
      throw new GenerationError("Response contained no text block");
    }

    // output_config.format guarantees valid JSON matching the schema.
    const value = JSON.parse(text) as T;

    if (!validate) return value;

    try {
      validate(value);
      return value;
    } catch (error) {
      const complaint = error instanceof Error ? error.message : String(error);
      if (attempt === 1) {
        throw new GenerationError(`Output still invalid after a retry: ${complaint}`);
      }
      messages.push(
        { role: "assistant", content: text },
        {
          role: "user",
          content: `That response did not meet the requirements: ${complaint}\n\nProduce the full result again, corrected.`,
        },
      );
    }
  }

  // Unreachable: the loop either returns or throws.
  throw new GenerationError("Generation failed");
}
