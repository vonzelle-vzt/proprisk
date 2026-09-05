import { z } from 'zod';
import type { ParsedIntent, BotIntent } from '@/types/ai';
import { askClaudeJSON, CLAUDE_MODELS } from '@/lib/ai/claude';

interface IntentPattern {
  intent: BotIntent;
  patterns: RegExp[];
  extractParams?: (match: RegExpMatchArray, input: string) => Record<string, string>;
}

const ACCOUNT_ID_PATTERN = /\b(\d{4,10})\b/;

function extractAccountId(input: string): Record<string, string> {
  const match = input.match(ACCOUNT_ID_PATTERN);
  return match ? { accountId: match[1] } : {};
}

const INTENT_PATTERNS: IntentPattern[] = [
  {
    intent: 'help',
    patterns: [
      /\bhelp\b/i,
      /\bcommands?\b/i,
      /what can you do/i,
      /how do (i|you) use/i,
    ],
  },
  {
    intent: 'morning_report',
    patterns: [
      /morning\s*report/i,
      /daily\s*report/i,
      /general\s*report/i,
      /briefing/i,
      /today'?s?\s*report/i,
      /overnight\s*report/i,
      /generate\s*report/i,
      /full\s*report/i,
    ],
  },
  {
    intent: 'account_trades',
    patterns: [
      /trades?\s*(for|of|on)\s*/i,
      /trade\s*history\s*/i,
      /trading\s*activity\s*/i,
    ],
    extractParams: (_m, input) => extractAccountId(input),
  },
  {
    intent: 'account_violations',
    patterns: [
      /violations?\s*(for|of|on)\s*\d/i,
      /deductions?\s*(for|of|on)\s*\d/i,
      /check\s*violations?\s*/i,
    ],
    extractParams: (_m, input) => extractAccountId(input),
  },
  {
    intent: 'risk_score',
    patterns: [
      /risk\s*score\s*(for|of|on)?\s*/i,
      /score\s*(for|of)?\s*\d/i,
      /how\s*risky\s*(is)?\s*/i,
    ],
    extractParams: (_m, input) => extractAccountId(input),
  },
  {
    intent: 'account_lookup',
    patterns: [
      /look\s*up\s*\d/i,
      /check\s*account\s*/i,
      /account\s*details?\s*(for|of|on)?\s*\d/i,
      /account\s*\d{4,}/i,
      /review\s*account\s*/i,
      /show\s*(me\s*)?account\s*/i,
    ],
    extractParams: (_m, input) => extractAccountId(input),
  },
  {
    intent: 'high_risk',
    patterns: [
      /high\s*risk/i,
      /risky\s*accounts?/i,
      /critical\s*accounts?/i,
      /flagged\s*accounts?/i,
      /most\s*dangerous/i,
      /worst\s*accounts?/i,
      /top\s*risk/i,
    ],
  },
  {
    intent: 'security_check',
    patterns: [
      /security\s*(check|flags?|issues?|alerts?)?/i,
      /blacklist(ed)?/i,
      /kyc\s*(fail|issue|check|status)/i,
      /security\s*flags?/i,
      /suspicious/i,
    ],
  },
  {
    intent: 'violations_summary',
    patterns: [
      /violations?\s*(summary|overview|breakdown|report)?$/i,
      /violation\s*(summary|overview|breakdown)/i,
      /all\s*violations?/i,
      /violation\s*types?/i,
    ],
  },
  {
    intent: 'deduction_history',
    patterns: [
      /deduction\s*(history|log|events?)/i,
      /ledger\s*(events?|history)?/i,
      /recent\s*deductions?/i,
      /deduction\s*summary/i,
    ],
  },
  {
    intent: 'pending_payouts',
    patterns: [
      /pending\s*payouts?/i,
      /payout\s*(queue|list|pending)/i,
      /show\s*(me\s*)?payouts?/i,
      /payouts?\s*(overview|summary)?$/i,
      /what'?s?\s*pending/i,
    ],
  },
  {
    intent: 'fraud_hunt',
    patterns: [
      /fraud\s*(scan|hunt|check|detection)/i,
      /run\s*fraud/i,
      /cross[\s-]*account\s*(fraud|check)/i,
      /fraud\s*hunter/i,
    ],
  },
  {
    intent: 'fraud_report',
    patterns: [
      /fraud\s*(report|findings|investigations?|results?)/i,
      /open\s*investigations?/i,
      /fraud\s*status/i,
    ],
  },
  {
    intent: 'enforcement_queue',
    patterns: [
      /enforcement\s*(queue|list|pending)?/i,
      /pending\s*enforcement/i,
      /show\s*enforcement/i,
      /enforcement\s*actions?/i,
    ],
  },
  {
    intent: 'enforcement_summary',
    patterns: [
      /enforcement\s*(summary|overview|stats|report)/i,
      /enforcer\s*(summary|status|report)/i,
    ],
  },
  {
    intent: 'repeat_offenders',
    patterns: [
      /repeat\s*offender/i,
      /serial\s*violat/i,
      /frequent\s*violat/i,
      /worst\s*offender/i,
    ],
  },
];

export function parseIntent(message: string): ParsedIntent {
  const trimmed = message.trim();

  for (const { intent, patterns, extractParams } of INTENT_PATTERNS) {
    for (const pattern of patterns) {
      const match = trimmed.match(pattern);
      if (match) {
        const params = extractParams ? extractParams(match, trimmed) : {};
        // If intent needs an accountId but none found, still check the full message
        if (!params.accountId && needsAccountId(intent)) {
          const fallback = extractAccountId(trimmed);
          if (fallback.accountId) {
            return { intent, params: fallback };
          }
        }
        return { intent, params };
      }
    }
  }

  // Last resort: if the message is just a number, treat as account lookup
  if (/^\d{4,10}$/.test(trimmed)) {
    return { intent: 'account_lookup', params: { accountId: trimmed } };
  }

  // If message contains a question mark or seems like a question, try general_question
  // (lowConfidence: matched only by this catch-all, not a specific intent pattern above)
  if (trimmed.includes('?') || /^(what|how|why|who|when|where|which|is|are|do|does|can|could|tell|show|explain|give|list|any|total|count|number)/i.test(trimmed)) {
    return { intent: 'general_question', params: { message: trimmed }, lowConfidence: true };
  }

  // Fallback: treat anything with risk/payout/violation keywords as a general question too
  // (lowConfidence: same reasoning — no specific keyword hit, just a loose topic match)
  if (/\b(payout|violation|deduction|risk|account|trader|balance|trade|ban|blacklist|kyc|profit|loss)\b/i.test(trimmed)) {
    return { intent: 'general_question', params: { message: trimmed }, lowConfidence: true };
  }

  return { intent: 'unknown', params: {}, lowConfidence: true };
}

function needsAccountId(intent: BotIntent): boolean {
  return ['account_lookup', 'account_violations', 'account_trades', 'risk_score'].includes(intent);
}

/**
 * One-line description per intent the LLM classifier is allowed to pick,
 * shown to the model as its catalog. Deliberately excludes 'unknown' (not a
 * real destination) — 'general_question' is the safe fallback if nothing fits.
 */
const INTENT_CATALOG: Record<Exclude<BotIntent, 'unknown'>, string> = {
  help: 'User is asking what the bot can do / how to use it.',
  morning_report: 'Full daily/morning risk briefing across all accounts.',
  pending_payouts: 'List or summary of pending payout requests.',
  account_lookup: 'Look up details for one specific account (needs accountId).',
  violations_summary: 'Aggregate summary of violations across all accounts.',
  high_risk: 'List of the highest-risk accounts.',
  account_violations: 'Violations for one specific account (needs accountId).',
  account_trades: 'Trade history for one specific account (needs accountId).',
  deduction_history: 'Recent ledger/deduction events across accounts.',
  security_check: 'Blacklist, KYC, and other security-flag checks.',
  risk_score: 'Risk score for one specific account (needs accountId).',
  fraud_hunt: 'Run a cross-account fraud detection scan.',
  fraud_report: 'Existing fraud investigation findings/status.',
  enforcement_queue: 'List of pending enforcement actions.',
  enforcement_summary: 'Summary/stats of the enforcement queue.',
  repeat_offenders: 'Accounts with repeated/serial violations.',
  general_question: "Anything else — a free-form question that doesn't map to a specific command above.",
};

const ClassifyResultSchema = z.object({
  intent: z.enum(
    Object.keys(INTENT_CATALOG) as [Exclude<BotIntent, 'unknown'>, ...Exclude<BotIntent, 'unknown'>[]]
  ),
  accountId: z.string().optional(),
});

/**
 * LLM fallback classifier for messages the regex fast-path couldn't confidently
 * bucket (see `ParsedIntent.lowConfidence`). Callers must guard this themselves
 * — `askClaudeJSON` throws in demo mode / without `ANTHROPIC_API_KEY` — and
 * treat any error as "fall back to the regex result", per `askClaude`'s
 * documented demo chokepoint contract.
 */
export async function classifyIntentWithLLM(message: string): Promise<ParsedIntent> {
  const catalog = Object.entries(INTENT_CATALOG)
    .map(([intent, desc]) => `- ${intent}: ${desc}`)
    .join('\n');

  const result = await askClaudeJSON({
    model: CLAUDE_MODELS.classify,
    system: 'You are an intent classifier for a prop-firm risk-management chat bot. Respond with ONLY JSON, no commentary.',
    prompt: `Classify this user message into exactly one of the intents below. If it references a specific numeric account id, extract it into "accountId".\n\nIntents:\n${catalog}\n\nMessage: "${message}"\n\nRespond with JSON: {"intent": "<one of the intent ids above>", "accountId"?: "<digits, if present>"}`,
    maxTokens: 150,
    schema: ClassifyResultSchema,
  });

  return { intent: result.intent, params: result.accountId ? { accountId: result.accountId } : {} };
}
