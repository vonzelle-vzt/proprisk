/**
 * Per-violation decision reports — the public surface.
 *
 * Split deliberately: `build` does I/O and persistence, `render-*` are pure
 * functions of a `ViolationReport`, and `demo` never touches the database.
 * Route handlers should import from here so the split stays visible.
 */

export type {
  ReportRuleSource,
  ReportTimelineKind,
  ViolationReport,
  ViolationReportRecord,
  ViolationReportSubjectType,
} from './types';
export { NARRATIVE_DISCLAIMER, VIOLATION_REPORT_SCHEMA_VERSION } from './types';

export {
  assembleViolationReport,
  buildViolationReport,
  canonicalJson,
  contentHashOf,
  getLatestViolationReport,
  legacyLimitSentence,
  listViolationReportsForAccount,
  reportOf,
  requestScopedReportDb,
  usd,
  ViolationNotFoundError,
} from './build';
export type {
  BuildViolationReportInput,
  BuildViolationReportResult,
  ReportDb,
  ViolationReportSources,
} from './build';

export { buildDemoViolationReport } from './demo';
export { renderViolationReportPdf } from './render-pdf';
export {
  renderAccountViolationsCsv,
  renderViolationReportCsv,
  VIOLATION_CSV_SECTIONS,
} from './render-csv';
export type { AccountViolationReportEntry } from './render-csv';
