import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { ActivationBlockedError, PackImmutableError, PackValidationError } from '@/lib/rulepack/store';
import { logError } from '@/lib/logging/logger';

/**
 * Every rule pack route funnels its catch block through this.
 *
 * The store's typed errors carry customer-facing messages on purpose — they
 * explain WHY a pack was rejected or an activation blocked, in language a firm
 * reads without a code reference. Collapsing them into a generic 500 would
 * throw that away at exactly the point it matters most.
 */
export function rulePackErrorResponse(err: unknown, route: string): NextResponse {
  if (err instanceof PackValidationError) {
    return NextResponse.json({ error: err.message, details: err.errors }, { status: 422 });
  }
  if (err instanceof PackImmutableError) {
    return NextResponse.json({ error: err.message }, { status: 409 });
  }
  if (err instanceof ActivationBlockedError) {
    return NextResponse.json({ error: err.message }, { status: 409 });
  }
  if (err instanceof ZodError) {
    return NextResponse.json(
      { error: 'Rule pack failed schema validation', details: err.issues },
      { status: 400 }
    );
  }

  logError('Rule pack route failed', err, { route, category: 'database' });
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}
