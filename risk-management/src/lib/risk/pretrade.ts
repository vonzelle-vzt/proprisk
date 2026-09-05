import type { PreTradeDecision, PreTradeInput, RiskRule } from '@/types/risk';

function round(num: number, precision = 4): number {
  const factor = 10 ** precision;
  return Math.round(num * factor) / factor;
}

function computeRiskAmount(input: PreTradeInput): number {
  const distance = Math.abs(input.entry_price - input.stop_loss_price);
  return round(distance * input.quantity, 4);
}

export function evaluatePreTrade(input: PreTradeInput, rules: RiskRule[]): PreTradeDecision {
  const enabledRules = rules.filter((rule) => rule.enabled);
  const violations: PreTradeDecision['violations'] = [];
  const suggestions: PreTradeDecision['suggestions'] = [];

  const riskAmount = computeRiskAmount(input);
  const riskPercent = input.account_balance > 0 ? round((riskAmount / input.account_balance) * 100, 4) : 0;

  for (const rule of enabledRules) {
    if (rule.type === 'instrument_blocklist') {
      const blocked = rule.instrument_list?.includes(input.symbol.toUpperCase()) ?? false;
      if (blocked) {
        violations.push({
          rule_id: rule.id,
          rule_type: rule.type,
          severity: 'critical',
          message: `Symbol ${input.symbol.toUpperCase()} is blocked by risk profile.`,
          current_value: input.symbol.toUpperCase(),
          threshold_value: 'BLOCKLIST',
        });
      }
      continue;
    }

    if (rule.type === 'max_position_risk_pct' && rule.threshold !== null) {
      if (riskPercent > rule.threshold) {
        violations.push({
          rule_id: rule.id,
          rule_type: rule.type,
          severity: 'critical',
          message: 'Position risk exceeds configured max position risk percent.',
          current_value: riskPercent,
          threshold_value: rule.threshold,
        });
        const suggestedQuantity = Math.max(
          0,
          Math.floor((rule.threshold / 100) * input.account_balance / Math.max(Math.abs(input.entry_price - input.stop_loss_price), 0.0000001))
        );
        suggestions.push({
          message: `Reduce quantity to ${suggestedQuantity} or lower to satisfy max position risk.`,
          suggested_quantity: suggestedQuantity,
        });
      } else if (rule.warning_threshold !== null && riskPercent > rule.warning_threshold) {
        violations.push({
          rule_id: rule.id,
          rule_type: rule.type,
          severity: 'medium',
          message: 'Position risk is near configured max position risk percent.',
          current_value: riskPercent,
          threshold_value: rule.warning_threshold,
        });
      }
      continue;
    }

    if (rule.type === 'max_daily_loss' && rule.threshold !== null) {
      const projectedDailyLoss = Math.abs(Math.min(0, input.daily_realized_pnl - riskAmount));
      if (projectedDailyLoss > rule.threshold) {
        violations.push({
          rule_id: rule.id,
          rule_type: rule.type,
          severity: 'critical',
          message: 'Projected daily loss exceeds configured daily loss cap.',
          current_value: projectedDailyLoss,
          threshold_value: rule.threshold,
        });
      } else if (rule.warning_threshold !== null && projectedDailyLoss > rule.warning_threshold) {
        violations.push({
          rule_id: rule.id,
          rule_type: rule.type,
          severity: 'medium',
          message: 'Projected daily loss is near configured daily loss cap.',
          current_value: projectedDailyLoss,
          threshold_value: rule.warning_threshold,
        });
      }
      continue;
    }

    if (rule.type === 'max_consecutive_losses' && rule.threshold !== null) {
      if (input.consecutive_losses >= rule.threshold) {
        violations.push({
          rule_id: rule.id,
          rule_type: rule.type,
          severity: 'high',
          message: 'Consecutive loss cap reached.',
          current_value: input.consecutive_losses,
          threshold_value: rule.threshold,
        });
      } else if (
        rule.warning_threshold !== null &&
        input.consecutive_losses >= rule.warning_threshold
      ) {
        violations.push({
          rule_id: rule.id,
          rule_type: rule.type,
          severity: 'low',
          message: 'Consecutive losses nearing configured cap.',
          current_value: input.consecutive_losses,
          threshold_value: rule.warning_threshold,
        });
      }
    }
  }

  const hasCriticalOrHigh = violations.some((v) => v.severity === 'critical' || v.severity === 'high');
  const hasWarnOnly = violations.some((v) => v.severity === 'medium' || v.severity === 'low');

  const result: PreTradeDecision['result'] = hasCriticalOrHigh ? 'block' : hasWarnOnly ? 'warn' : 'pass';

  return {
    result,
    risk_amount: riskAmount,
    risk_percent: riskPercent,
    violations,
    suggestions,
  };
}
