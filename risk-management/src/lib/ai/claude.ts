import { DEMO_MODE } from '@/lib/demo';
import type { ZodSchema } from 'zod';

/**
 * Raw-fetch Claude client (no SDK dependency) for live-mode AI features:
 * executive narratives for evidence packs, payout-decision explanations, and
 * chat classification. Talks directly to the Messages API.
 *
 * Structural demo chokepoint: a demo deployment must never be able to spend
 * real API credits, even if `ANTHROPIC_API_KEY` is set — mirrors the pattern
 * in `src/lib/supabase/admin.ts` (`createAdminClient`) and
 * `src/lib/platform/client.ts` (`PlatformNotConfiguredError`).
 */

export const CLAUDE_MODELS = {
  narrative: 'claude-sonnet-5',
  classify: 'claude-haiku-4-5-20251001',
} as const;

export type ClaudeModel = (typeof CLAUDE_MODELS)[keyof typeof CLAUDE_MODELS];

const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

function assertClaudeAvailable(): string {
  if (DEMO_MODE) {
    throw new Error('Claude client disabled in demo mode');
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not configured');
  }
  return apiKey;
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

interface AskClaudeParams {
  model: ClaudeModel | string;
  system?: string;
  prompt: string;
  maxTokens?: number;
}

interface AnthropicMessageResponse {
  content: Array<{ type: string; text?: string }>;
  usage?: { input_tokens: number; output_tokens: number };
}

async function callAnthropic(params: AskClaudeParams, apiKey: string): Promise<AnthropicMessageResponse> {
  const { model, system, prompt, maxTokens = 1024 } = params;
  const MAX_RETRIES = 2;
  let lastError: unknown;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const start = Date.now();
    try {
      const res = await fetch(ANTHROPIC_MESSAGES_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          ...(system ? { system } : {}),
          messages: [{ role: 'user', content: prompt }],
        }),
      });

      if (!res.ok) {
        if (isRetryableStatus(res.status) && attempt < MAX_RETRIES) {
          lastError = new Error(`Anthropic API ${res.status}`);
          await sleep(2 ** attempt * 500);
          continue;
        }
        const bodyText = await res.text().catch(() => '');
        throw new Error(`Anthropic API error ${res.status}: ${bodyText}`);
      }

      const json = (await res.json()) as AnthropicMessageResponse;
      const ms = Date.now() - start;
      console.log('[claude]', {
        model,
        input_tokens: json.usage?.input_tokens ?? 0,
        output_tokens: json.usage?.output_tokens ?? 0,
        ms,
      });
      return json;
    } catch (err) {
      lastError = err;
      // Network-level failure (fetch throw) — retry with backoff.
      if (attempt < MAX_RETRIES) {
        await sleep(2 ** attempt * 500);
        continue;
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Anthropic API call failed');
}

function extractText(response: AnthropicMessageResponse): string {
  return response.content
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

function stripCodeFences(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return (fenced ? fenced[1] : text).trim();
}

/** Ask Claude for freeform text. Throws in demo mode / when unconfigured. */
export async function askClaude(params: AskClaudeParams): Promise<string> {
  const apiKey = assertClaudeAvailable();
  const response = await callAnthropic(params, apiKey);
  return extractText(response);
}

interface AskClaudeJSONParams<T> extends AskClaudeParams {
  schema: ZodSchema<T>;
}

/**
 * Ask Claude for a JSON payload validated against `schema`. Strips code
 * fences before parsing. On a parse/validation failure, re-asks once with the
 * validation error appended to the prompt before giving up.
 */
export async function askClaudeJSON<T>(params: AskClaudeJSONParams<T>): Promise<T> {
  const apiKey = assertClaudeAvailable();
  const { schema, ...askParams } = params;

  const attempt = async (prompt: string): Promise<T> => {
    const response = await callAnthropic({ ...askParams, prompt }, apiKey);
    const text = stripCodeFences(extractText(response));
    const parsedJson = JSON.parse(text);
    return schema.parse(parsedJson);
  };

  try {
    return await attempt(params.prompt);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const retryPrompt = `${params.prompt}\n\nYour previous response was invalid: ${reason}. Respond with ONLY valid JSON matching the required shape, no commentary or code fences.`;
    return attempt(retryPrompt);
  }
}
