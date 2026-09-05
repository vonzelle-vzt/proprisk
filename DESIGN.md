```yaml
version: 1
name: Risk Management Platform (white-label, multi-asset)
description: >
  A dark, dense, glassmorphic risk terminal for prop-firm operators. It should feel like an
  instrument panel, not a marketing site: near-black canvas, translucent white cards with a
  hairline edge and heavy backdrop blur, and information packed at 10-11px so an operator sees a
  whole book of accounts without scrolling. Red is the brand AND the alarm colour — it carries
  the primary CTA, the focus ring, and critical severity. Everything else is deliberately
  restrained to greys: there is no secondary brand hue, no illustration, no gradient, and no
  light mode. Colour is never the only carrier of a risk signal — every severity is also a word
  or a number.

# Where these values are copied FROM. See "Token source of truth" below.
source: risk-management/src/styles/globals.css

# ── Base layer ──────────────────────────────────────────────────────────────
# All 9 custom properties declared at :root in globals.css, verbatim.
# `consumers:` is the MEASURED count of code that actually reads the property.
# Six of the nine are declared but dead — see "Known gaps". Do not assume a
# token is wired just because it is listed here.
colors:
  background: "#0a0a0a"        # consumers: 0  (body hardcodes #0a0a0a instead)
  card-bg: "rgba(255, 255, 255, 0.05)"  # consumers: 0  (components write bg-white/5)
  accent-red: "#dc2626"        # consumers: 1  (tailwind.config.ts -> `accent-red`) THEMEABLE
  silver: "#c0c0c0"            # consumers: 1  (tailwind.config.ts -> `silver`)     THEMEABLE
  silver-light: "#e5e7eb"      # consumers: 1  (tailwind.config.ts -> `silver-light`) structural
  text-primary: "#f5f5f5"      # consumers: 0  (body hardcodes #f5f5f5)
  text-secondary: "#9ca3af"    # consumers: 0
  glass-border: "rgba(255, 255, 255, 0.1)"  # consumers: 0  (components write border-white/10)
  glass-blur: "24px"           # consumers: 0  (components write backdrop-blur-xl)

# Literal values that carry the actual UI, because the tokens above are unwired.
# These are DESCRIPTIVE of today's code, not an endorsement — see Do's and don'ts.
effective-palette:
  canvas: "#0a0a0a"            # body background + focus-ring offset
  surface: "bg-white/5"        # + backdrop-blur-xl + border-white/10 + rounded-2xl
  surface-hover: "bg-white/10" # + border-red-500/30
  text-strong: "text-white"
  text-body: "text-gray-300"
  text-muted: "text-gray-400"
  text-faint: "text-gray-500"
  accent: "red-600"            # buttons; red-500 for rings, borders, criticals
  focus-ring: "ring-red-500/50 ring-offset-2 ring-offset-[#0a0a0a]"

typography:
  # Font is loaded by next/font/google in src/app/layout.tsx and applied as a
  # class on <body>. That class BEATS the `body { font-family }` rule in
  # globals.css on specificity, so Inter is authoritative and the "Geist"
  # fallback listed in the stylesheet never applies.
  family: Inter (next/font/google, subset latin), fallback sans-serif
  # Measured usage across risk-management/src/**/*.tsx. The dense arbitrary
  # sizes are the house style, not drift: text-[10px] and text-[11px] together
  # outnumber the entire named scale.
  micro:
    fontSize: 10px   # `text-[10px]` — 290 uses. Stat labels, table cells, meta.
    use: the default body size of this product
  micro-plus:
    fontSize: 11px   # `text-[11px]` — 174 uses. Table values, dense rows.
  nano:
    fontSize: 9px    # `text-[9px]` — 26 uses. Badge text ONLY.
  xs:
    fontSize: 12px   # `text-xs` — 234 uses. Buttons (sm), form labels.
  sm:
    fontSize: 14px   # `text-sm` — 102 uses. Buttons (md), section headers.
  lg:
    fontSize: 18px   # `text-lg` — 19 uses. StatCard values, modal titles.
  xl:
    fontSize: 20px   # `text-xl` — 10 uses.
  2xl:
    fontSize: 24px   # `text-2xl` — 5 uses. Page/login headings.
  3xl:
    fontSize: 30px   # `text-3xl` — 2 uses. Largest type in the product.

spacing:
  # No spacing scale is defined in the token layer. These are the GlassCard
  # padding steps from src/components/ui/glass-card.tsx — the only codified
  # spacing decision in the repo.
  card-none: 0
  card-sm: 12px    # p-3 — dense tables, StatCard
  card-md: 20px    # p-5 — default
  card-lg: 32px    # p-8 — login, empty states

rounded:
  # Measured usage. `rounded-glass` (16px) IS defined in tailwind.config.ts and
  # is used ZERO times — do not reach for it, it is not the card radius.
  md: 6px      # rounded-md — 6 uses
  lg: 8px      # rounded-lg — 118 uses. Default for inputs, chips, inner blocks.
  xl: 12px     # rounded-xl — 58 uses. Buttons, tooltips, modals.
  2xl: 16px    # rounded-2xl — 10 uses. GlassCard ONLY.
  full: 9999px # rounded-full — 30 uses. Dots, pills, progress bars.

motion:
  duration-fast: 200ms   # `transition-all duration-200` — Button
  duration-base: 300ms   # `transition-all duration-300` — GlassCard hover
  transition-colors: default (150ms) — StatCard hover, icon hover
  # There is no reduced-motion handling anywhere in the repo. See Known gaps.

# ── Variant layers ──────────────────────────────────────────────────────────
# This product has exactly ONE real variant scope, and it is not a theme
# toggle — it is the white-label tenant override. Do not invent others.
variants:
  ':root (runtime-injected by src/config/brand.ts -> brandCssOverrides())':
    description: >
      The white-label tenant layer. src/app/layout.tsx renders `<style>{cssOverrides}</style>`
      inside <body>, emitting a second `:root{}` block. Same specificity as globals.css but
      later in document order, so it WINS. Only emitted for env vars that are set and non-empty.
      This is the ONLY mechanism by which a tenant may change a colour.
    themeable:
      accent-red: NEXT_PUBLIC_BRAND_ACCENT   # default #dc2626
      silver: NEXT_PUBLIC_BRAND_NEUTRAL      # default #c0c0c0
    structural-never-override: >
      Every other token. --background, --card-bg, --text-primary, --text-secondary,
      --glass-border, --glass-blur and --silver-light are NOT tenant-facing: the near-black
      canvas and the glass surface ladder are the product's identity and its legibility
      contract, not a brand slot. A tenant that could set --background could make every
      severity colour fail contrast.
    non-colour-brand-slots: >
      NEXT_PUBLIC_BRAND_NAME, _COMPANY, _TAGLINE, _LOGO_URL, _FAVICON_URL (src/config/brand.ts).
      These are fully wired and DO work — sidebar, login, evidence print header, metadata.
    status: >
      WIRED BUT UNREACHED. Measured: 0 uses of `bg-accent-red` / `text-silver` / any themeable
      class in 80 .tsx files. Setting NEXT_PUBLIC_BRAND_ACCENT today changes nothing on screen.
      See Known gaps #1 — this is the single most important fact in this file.
  'html.dark (src/app/layout.tsx)':
    description: >
      INERT. The root <html> carries className="dark", but tailwind.config.ts sets no
      `darkMode` key, no `.dark {}` rule exists in any stylesheet, and there are zero `dark:`
      utilities in the codebase. The app is dark by hardcoded value, not by variant. Do not add
      `dark:` utilities expecting them to work, and do not remove the class assuming it is live
      — treat it as an unimplemented hook.

# ── Components ──────────────────────────────────────────────────────────────
# Only components that exist in src/components/ui/. Bindings are transcribed
# from source; where a component hardcodes a palette class rather than a token,
# that is recorded as-is, because pretending otherwise is how drift compounds.
components:
  GlassCard:                       # src/components/ui/glass-card.tsx
    base: bg-white/5 + backdrop-blur-xl + border border-white/10 + rounded-2xl + shadow-2xl
    padding: none | sm (p-3) | md (p-5, default) | lg (p-8)
    hover: "hover:bg-white/10 hover:border-red-500/30 transition-all duration-300 cursor-pointer (opt-in via `hover`)"
    glow: "none | red (border-red-500/50 shadow-red-500/10) | silver (border-gray-400/50 shadow-gray-400/10)"
    rule: never hand-roll the glass stack; compose GlassCard.
  Button:                          # src/components/ui/button.tsx
    base: inline-flex + gap-2 + rounded-xl + border + font-medium + transition-all duration-200
    focus: focus:ring-2 focus:ring-red-500/50 focus:ring-offset-2 focus:ring-offset-[#0a0a0a]
    disabled: disabled:opacity-50 disabled:cursor-not-allowed (also forced while `loading`)
    loading: leading Loader2 spinner, button disabled
    variants:
      primary: bg-red-600 hover:bg-red-700 text-white border-red-500/50 shadow-red-500/20
      success: bg-emerald-600 hover:bg-emerald-700
      warning: bg-orange-600 hover:bg-orange-700
      secondary: bg-white/10 hover:bg-white/20 text-gray-200 border-white/20
      danger: bg-red-900/50 hover:bg-red-900/70 text-red-300 border-red-500/30
      ghost: bg-transparent hover:bg-white/5 text-gray-400
    sizes: sm (px-3 py-1.5 text-xs) | md (px-4 py-2 text-sm) | lg (px-6 py-3 text-base)
  Badge:                           # src/components/ui/badge.tsx
    base: px-1.5 py-px + rounded + text-[9px] + font-medium + border + leading-none + whitespace-nowrap
    pattern: every variant is `bg-{hue}-500/20 text-{hue}-400 border-{hue}-500/30`
    variants: default (white/10) | red | green (emerald) | yellow | blue | purple | silver (gray-400)
    warning: >
      the `silver` variant renders gray-400 and has NOTHING to do with the --silver token.
      A tenant's NEXT_PUBLIC_BRAND_NEUTRAL will not change it.
  StatCard:                        # src/components/ui/stat-card.tsx
    composition: GlassCard padding="sm"
    label: text-[10px] font-medium uppercase tracking-wider text-gray-400
    value: text-lg font-bold text-white leading-tight
    subtitle: text-[10px] text-gray-500
    info: hover tooltip — bg-[#1a1a1f] border-white/15 rounded-lg text-[10px] text-gray-400
    trend: ">= 0 renders text-red-400, < 0 renders text-emerald-400 — INVERTED on purpose: this is a risk product, a rising number is bad news."
```

---

## Overview

This is an operator's console for prop-firm risk: who is breaching, how badly, what it costs,
and what to do about it. The visual language exists to serve density and alarm legibility, in
that order.

The surface system is a single idea repeated: a near-black canvas at `#0a0a0a`, and translucent
white cards (`bg-white/5`) lifted off it by a heavy `backdrop-blur-xl` and a 1px `border-white/10`
hairline. There is no second surface colour and no shadow-based elevation ladder — depth comes
from translucency and the hairline, not from drop shadows.

Defining characteristics:

- **Dense by default.** 10px and 11px are the body sizes, not the fine print. 464 of the type
  declarations in this codebase are 10-11px arbitrary values. A component that lands at 14px
  will look wrong next to everything else.
- **Red is load-bearing twice.** It is the brand accent *and* the critical-severity colour. That
  overload is deliberate in a risk product but it constrains white-labelling — see Known gaps.
- **Monochrome otherwise.** Greys carry all structure. Hues (emerald, yellow, blue, purple,
  orange) are reserved for *encoded meaning* — severity, violation type, pass/fail — never for
  decoration.
- **Colour is never alone.** Every severity indicator in the product is accompanied by its label
  or its score. Preserve this.
- **Dark only.** There is no light mode and no mechanism for one.

## Colors

**Brand and accent**

- `{colors.accent-red}` **#dc2626** — the one brand hue. Primary buttons (`red-600`), focus
  rings (`red-500/50`), card hover borders (`red-500/30`), critical severity. **Themeable.**
- `{colors.silver}` **#c0c0c0** — the metallic neutral of the brand mark. **Themeable.**
- `{colors.silver-light}` **#e5e7eb** — structural, not tenant-facing.

**Surface**

- Canvas **#0a0a0a** — the page. Also the focus-ring offset colour.
- Card `bg-white/5` + `backdrop-blur-xl` + `border-white/10` — the only card treatment.
- Card hover `bg-white/10` + `border-red-500/30`.
- Popover/tooltip `#1a1a1f`, chart tooltip `#1a1a1a` — the only two raised opaque surfaces.

**Text**

- Strong `text-white` — values, headings, anything a number.
- Body `text-gray-300`, muted `text-gray-400`, faint `text-gray-500`, hint `text-gray-600`.
- Labels are `uppercase tracking-wider text-gray-400` at 10px.

**Semantic (risk encoding)**

- Critical `red-*`, high `orange-*`, medium `yellow-*`, low `blue-*` (`SEVERITY_COLORS`,
  `src/components/risk/constants.ts`).
- Positive/pass `emerald-*`. Violation-type hues come from `violationBadgeVariant()` in
  `src/lib/violations/labels.ts` — **that function is the single source of truth** for which
  hue a violation type gets. Do not write a new local map.

**Reserved / restraint rules**

- Emerald means "good outcome" only. It is not a generic UI accent.
- Purple, cyan, pink appear *only* as categorical series colours in chart code. They are data.
  Never introduce them as chrome.
- Chart series palettes (`BAR_COLORS` in `src/components/charts/breakdown-cards.tsx`,
  `RISK_COLOR` in `src/components/network/graph-canvas.tsx`, the Recharts `fill`/`stroke` props)
  are **data encodings, not chrome** — they are explicitly excluded from the compliance gate
  below and must not be "fixed" into tokens.

## Typography

Inter, loaded via `next/font/google` in `src/app/layout.tsx` and applied as a class on `<body>`.
That class out-specifies the `body { font-family: "Inter","Geist",sans-serif }` rule in
`globals.css`, so the `Geist` fallback listed there is dead text — do not rely on it.

| Token | Size | Weight | Use |
|---|---|---|---|
| `text-[8px]` / `text-[9px]` | 8-9px | 500 | Badges only |
| `text-[10px]` | 10px | 400-500 | **Default body.** Stat labels, table cells, meta |
| `text-[11px]` | 11px | 400-700 | Table values, dense rows |
| `text-xs` | 12px | 400-500 | Small buttons, form labels |
| `text-sm` | 14px | 400-600 | Medium buttons, section headers |
| `text-lg` | 18px | 700 | StatCard values, modal titles |
| `text-xl` / `text-2xl` | 20/24px | 700 | Page and login headings |
| `text-3xl` | 30px | 700 | Largest type in the product (2 uses) |

Principles:

- Go **down** a step before you go up. This product's instinct is compression.
- Uppercase + `tracking-wider` is the label treatment; body text is never uppercase.
- Numbers are `font-bold text-white`; their units and deltas are `text-gray-500`.
- There are **no tabular-figure settings anywhere**, so numeric columns shimmy on live updates.
  See Known gaps.

## Layout

There is no spacing token scale. The only codified spacing is `GlassCard`'s padding ladder:
`p-3` (12px, dense) / `p-5` (20px, default) / `p-8` (32px, login and empty states). Inside
cards, `gap-1` / `gap-2` / `gap-3` dominate.

Whitespace philosophy: the card supplies the breathing room; its contents do not. Rows are tight
(`py-px` to `py-2`) and lean on the hairline border and 10px type to stay readable. If a layout
feels cramped, add a card boundary rather than padding.

## Elevation & depth

Depth is **translucency plus hairline**, not shadow.

| Level | Treatment | Use |
|---|---|---|
| 0 | `#0a0a0a` | Page canvas |
| 1 | `bg-white/5` + `backdrop-blur-xl` + `border-white/10` + `shadow-2xl` | Every card |
| 1-hover | `bg-white/10` + `border-red-500/30` | Interactive cards |
| 1-glow | `border-red-500/50` + `shadow-red-500/10` | Cards flagged critical |
| 2 | Opaque `#1a1a1f` / `#1a1a1a` + `border-white/15` | Tooltips, chart tooltips, modals |

`shadow-2xl` here is atmosphere under the glass, not a lift cue. Do not introduce a shadow scale
to signal hierarchy — step the surface instead.

## Components

See the `components:` block above for token bindings and every state.

States worth restating, because they are the ones generated UI gets wrong:

- **Focus** is always `ring-2 ring-red-500/50` with `ring-offset-2 ring-offset-[#0a0a0a]`. Never
  ship `focus:outline-none` without that ring.
- **Disabled** is `opacity-50 cursor-not-allowed`, never a colour change.
- **Loading** on `Button` is a leading `Loader2` spinner and forces the disabled state.
- **Empty and error states have no documented treatment.** See Known gaps.

## Do's and don'ts

**Do**

- Compose `GlassCard`, `Button`, `Badge`, `StatCard` from `src/components/ui/` rather than
  rebuilding their styles.
- Get violation hues from `violationBadgeVariant()` and severity styling from
  `SEVERITY_COLORS` / `SEVERITY_BADGE` in `src/components/risk/constants.ts`.
- Pair every severity colour with a word or a number. A coloured dot alone is not a signal.
- Keep new type at 10-11px unless it is a headline value.
- When you add a *brand-coloured* surface, use the themeable classes (`bg-accent-red`,
  `text-silver`) so the tenant override can reach it. Today that count is 0 and it should only
  ever rise.

**Don't**

- **Don't hardcode `red-600`/`red-500` for anything that represents the BRAND** (primary CTA,
  focus ring, logo-adjacent chrome). That is what makes the white-label override a no-op. Alarm
  red for critical severity is a different, legitimate use.
- Don't add a raw Tailwind palette class to *new* code — it fails the ratchet in Compliance.
- Don't treat `Badge variant="silver"` or the `accent-red-500` utility as tokens. The first is
  `gray-400`; the second is Tailwind's `accent-color` property for checkboxes and range inputs.
  Both merely *look* like the token names.
- Don't edit `--background`, `--text-*`, `--glass-*` to solve a tenant-branding request — those
  are structural. Tenant colour lives only in the two themeable slots.
- Don't add `dark:` utilities; `darkMode` is not configured and they will not compile to
  anything useful.
- Don't convert chart series colours into tokens.

## Responsive behavior

Tailwind defaults (`sm` 640 / `md` 768 / `lg` 1024 / `xl` 1280 / `2xl` 1536); the config adds no
custom screens. Only 89 responsive-prefixed utilities exist across 80 `.tsx` files, so this is a
**desktop-first operator tool that has not been meaningfully adapted for small screens.** Dense
tables are the dominant layout and they do not currently reflow. Treat any mobile request as new
design work, not as applying this file. Touch-target minimums are not met by the 9-10px badge
and icon-button sizes — do not propagate those into a touch surface.

---

## Token source of truth

| | |
|---|---|
| **Authoritative file** | `risk-management/src/styles/globals.css` (`:root`, 9 custom properties) |
| **Second source** | `risk-management/tailwind.config.ts` — maps 3 of the 9 into utility classes via `var()`; hardcodes `background`, `card`, `text-primary`, `text-secondary` as literals that **diverge from the tokens by construction** |
| **Tenant override** | `risk-management/src/config/brand.ts` → `brandCssOverrides()` → injected `<style>` in `src/app/layout.tsx`. Runtime, env-driven, `:root`-scoped |
| **This file's role** | Derived. Regenerate the token inventory by re-running the measurements in the Compliance section after changing any of the three above. |
| **Consumers** | `risk-management/src/**` (80 `.tsx` files; single Next.js app, no packages) |
| **Not a source** | `.cursor/rules/glassmorphism.mdc` — absorbed into this file. Its prose (compose `GlassCard`, button-variant semantics, badge-by-violation-type) is carried above and still correct. Its *values* are stale where they conflict; **the code wins**. |
| **Not a gate** | `.claude/hooks/validators/design-tokens-validator.py` validates design-token **JSON** files against a generic protocol schema. This repo has no token JSON, so that validator never fires on the real token layer. It is not the oracle. |

Direction of derivation: `globals.css` → `tailwind.config.ts` → components. There is no mobile
app and no second platform theme file, so no cross-platform parity check is required.

## Compliance

Runnable verbatim **from the repo root**. Baseline-and-ratchet: fail on an *increase* (or, for
Gate 3, a *decrease*), never on the existing count. This layer is thin and the debt is real —
a flag-day gate here would simply be switched off.

```bash
# Gate 1 — raw Tailwind palette classes in feature code. Primary check.
grep -rInE '\b(bg|text|border|ring|from|to|via)-(slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-[0-9]{2,3}\b' risk-management/src --include='*.tsx' | wc -l
# BASELINE: 1179   ← fails if this number goes UP

# Gate 2 — raw hex in feature code. Secondary, and filtered.
#   var(--token, #hex)   correct defensive fallback pattern
#   src/components/charts/, src/components/network/   chart + graph SERIES colours
#                        are DATA, not chrome — excluded on purpose
#   src/lib/emails/      email clients cannot use CSS custom properties
#   src/lib/reports/     PDF renderers cannot resolve CSS custom properties either
#   src/lib/mock/        demo-mode fixtures, includes inline-styled email HTML
grep -rInE '#[0-9a-fA-F]{6}\b' risk-management/src --include='*.tsx' --include='*.ts' \
  | grep -v 'var(--' \
  | grep -vE 'risk-management/src/components/charts/|risk-management/src/components/network/|risk-management/src/lib/emails/|risk-management/src/lib/reports/|risk-management/src/lib/mock/|\.test\.|\.spec\.' | wc -l
# BASELINE: 33   ← fails if this number goes UP

# Gate 3 — WHITE-LABEL REACH (repo-specific, inverse ratchet).
# Counts code that can actually be re-coloured by a tenant. The two themeable
# tokens are reachable ONLY through these utility classes.
grep -rIoE '\b(bg|text|border|ring|from|to|via|fill|stroke|shadow)-(accent-red|silver-light|silver)\b' risk-management/src --include='*.tsx' | wc -l
# BASELINE: 0    ← fails if this number goes DOWN. Every brand-coloured surface
#                  converted from `red-600` to `accent-red` raises it.
#                  While it reads 0, NEXT_PUBLIC_BRAND_ACCENT is decorative.
```

## Known gaps

1. **White-label colour is wired end-to-end but reaches nothing.** `brandCssOverrides()`
   correctly emits a winning `:root` override for `--accent-red` and `--silver`, and
   `tailwind.config.ts` correctly maps both to `var()`. But **0 of 80 `.tsx` files use the
   resulting classes** — every brand-coloured surface is a literal `red-600` / `red-500` /
   `gray-400`. A tenant who sets `NEXT_PUBLIC_BRAND_ACCENT=#0055ff` today gets a blue nothing.
   The non-colour brand slots (name, company, logo, favicon, tagline) *do* work. Closing this is
   a scoped migration, not a restyle; it needs an explicit go-ahead because it touches ~337
   `red-*` occurrences and must not recolour alarm red along with brand red.
2. **Six of nine tokens are declared and dead** — `--background`, `--card-bg`, `--text-primary`,
   `--text-secondary`, `--glass-border`, `--glass-blur` have zero consumers; `body` and the
   components restate their values as literals. `rounded-glass` (16px), `backdrop-blur-xs`,
   `bg-card`, `text-text-primary`, `text-text-secondary` are defined in `tailwind.config.ts`
   and used zero times. Editing any of them changes nothing on screen — a trap for a later agent.
3. **Severity has three competing colour scales.** `SEVERITY_COLORS` says high=**orange**,
   medium=**yellow**, low=**blue**; `SEVERITY_BADGE` in the *same file* says high=**yellow**,
   medium=**blue**, low=**silver**; `src/app/(dashboard)/alerts/page.tsx` inlines a fourth
   variant; and score-threshold code (`>=70` red, `>=50` yellow) is a fifth. They are not
   reconcilable without a product decision on how many severity levels exist. Ask.
4. **No reduced-motion handling** anywhere — `animate-pulse` and `animate-spin` run regardless
   of `prefers-reduced-motion`.
5. **No light mode, and `html.dark` is inert** — no `darkMode` config, no `.dark {}` rule, no
   `dark:` utilities. Adding light mode is a token-layer project, not a styling task.
6. **No documented empty, error, or form-validation styling.** Loading has a spinner and
   `animate-pulse` skeletons; empty and error states are ad hoc per page. Ask before inventing.
7. **No focus-visible discipline audit.** `Button` has a correct ring; other interactive
   elements (table rows, cards with `onClick`, custom selects) have not been verified.
8. **Not responsive.** 89 breakpoint utilities across 80 files; dense tables do not reflow and
   touch targets are below minimum. Mobile is unbuilt, not merely unpolished.
9. **No contrast verification.** `text-gray-500`/`text-gray-600` at 10px on `#0a0a0a` is very
   likely below WCAG AA. Nothing in the repo checks it, and this file does not either.

## Marketing surface (public landing + pricing)

Added when `src/app/(marketing)/**` (public landing at `/home`, pricing at `/pricing`, shared
components in `src/components/marketing/`) was built for self-serve signup. Everything above this
section describes the **operator terminal** — the authenticated app a signed-in risk desk lives
in all day. The marketing surface is a different job: it has an audience of one visit, not an
operator staring at it for eight hours, and its only success metric is "did they click Start
free / Sign up." That difference is deliberate and narrow — it changes density and type scale,
nothing else.

**What carries over unchanged (do not re-derive, reuse verbatim):**

- Canvas `#0a0a0a`, `GlassCard`'s glass stack (`bg-white/5` + `backdrop-blur-xl` +
  `border-white/10` + `rounded-2xl` + `shadow-2xl`), and `Button`'s variants/focus ring. Compose
  `GlassCard` and reuse `Button`'s `primary`/`secondary` visual treatment (marketing CTAs are
  plain `<Link>`s styled to match `Button`, not `<button>` elements, since they navigate rather
  than submit — but the classes are copied from `Button`'s `primary`/`secondary` variants, not
  invented).
- `accent-red` (`red-600`/`red-500`) as the one brand hue and the only interactive/CTA colour.
  No new hue is introduced anywhere on this surface.
- Dark only. No light mode, no `dark:` utilities — same rule as the rest of the app.
- `brand.productName` / `brand.companyName` from `src/config/brand.ts` for all copy — never a
  hardcoded product name, so a white-label deployment's marketing page still reads correctly.

**What is deliberately different, and why:**

- **Type scale is the marketing default, not the 10-11px operator default.** Body copy is
  `text-base`/`text-lg` (16-18px), section headings `text-2xl`-`text-3xl` (24-30px), the hero
  headline `text-4xl`-`text-6xl` (36-60px). A visitor deciding whether to sign up is reading
  prose and a price, not scanning a table of 200 accounts — density that serves the terminal
  would make the pitch harder to read, not more efficient. Do not import `text-[10px]`/
  `text-[11px]` onto this surface.
- **Spacing is generous, not compressed.** Sections use `py-16`-`py-20`; `GlassCard` here always
  takes `padding="lg"`. The terminal's "the card supplies the breathing room, its contents do
  not" rule still applies — cards are still the boundary — but there are far fewer of them per
  screen, so each one can afford more air.
- **Pricing numbers have exactly one source.** `MarketingPricingTable` reads tier name, price,
  account ceiling and feature list from `src/lib/billing/plans.ts` — the same table
  `entitlements.ts` and the Stripe checkout route read. Never hardcode a price or a tier name
  into marketing copy; if the pricing page and the paywall can name different numbers, the
  "published pricing" claim this surface exists to make is a lie waiting to happen.

**Do**

- Compose `GlassCard`/reuse `Button`-styled links exactly as above.
- Keep every dollar figure and account ceiling sourced from `plans.ts`.
- Keep the one-brand-hue rule: `accent-red` for CTAs, greys for everything else, exactly like
  the terminal.

**Don't**

- Don't reuse `text-[10px]`/`text-[11px]` here — it is the terminal's signature, not a general
  house style, and it undersells the product on the one page meant to sell it.
- Don't introduce a second brand hue "to make the marketing page feel less bare." Restraint is
  the same rule as the terminal; density is the only thing this surface relaxes.
- Don't hand-roll a pricing card's numbers — import from `plans.ts`.

**Known gap:** `src/app/page.tsx` (the app root, `/`) still redirects straight into the
authenticated dashboard and is unchanged by this work — it sits outside this feature's file
scope. The public landing therefore lives at `/home`, not `/`, until someone with authority over
that file wires `/` to send a logged-out visitor to `/home` instead of straight to `/login`.
