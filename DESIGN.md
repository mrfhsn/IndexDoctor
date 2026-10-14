---
name: IndexDoctor
description: In-engine Postgres index advisor with real planner before/after diffs
colors:
  emerald-signal: '#10b981'
  emerald-bright: '#34d399'
  rose-bottleneck: '#f43f5e'
  rose-bright: '#fb7185'
  amber-warning: '#f59e0b'
  amber-bright: '#fbbf24'
  slate-canvas: '#020617'
  slate-surface: '#0f172a'
  slate-surface-elevated: '#1e293b'
  slate-border: '#1e293b'
  slate-border-focus: '#334155'
  text-primary: '#f1f5f9'
  text-secondary: '#cbd5e1'
  text-muted: '#94a3b8'
  text-subtle: '#64748b'
typography:
  display:
    fontFamily: "'Inter', ui-sans-serif, system-ui, sans-serif"
    fontSize: '1.25rem'
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: '-0.025em'
  headline:
    fontFamily: "'Inter', ui-sans-serif, system-ui, sans-serif"
    fontSize: '1rem'
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: '-0.015em'
  title:
    fontFamily: "'Inter', ui-sans-serif, system-ui, sans-serif"
    fontSize: '0.875rem'
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: '0.05em'
  body:
    fontFamily: "'Inter', ui-sans-serif, system-ui, sans-serif"
    fontSize: '0.875rem'
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: 'normal'
  label:
    fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"
    fontSize: '0.75rem'
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: 'normal'
  caption:
    fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"
    fontSize: '0.6875rem'
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: 'normal'
rounded:
  sm: '4px'
  md: '6px'
  lg: '8px'
  xl: '12px'
  2xl: '16px'
  full: '9999px'
spacing:
  xs: '4px'
  sm: '8px'
  md: '16px'
  lg: '24px'
  xl: '32px'
components:
  button-primary:
    backgroundColor: '{colors.emerald-signal}'
    textColor: '{colors.slate-canvas}'
    rounded: '{rounded.xl}'
    padding: '10px 24px'
  button-primary-hover:
    backgroundColor: '{colors.emerald-bright}'
  button-secondary:
    backgroundColor: '{colors.slate-surface}'
    textColor: '{colors.text-secondary}'
    rounded: '{rounded.xl}'
    padding: '10px 14px'
  tab-active:
    backgroundColor: '{colors.emerald-signal}'
    textColor: '{colors.slate-canvas}'
    rounded: '{rounded.md}'
    padding: '4px 12px'
  badge-status:
    backgroundColor: '{colors.slate-surface}'
    textColor: '{colors.emerald-bright}'
    rounded: '{rounded.full}'
    padding: '4px 10px'
---

# Design System: IndexDoctor

## Overview

**Creative North Star: "The In-Engine Cockpit"**

IndexDoctor's interface is designed as an instrument-grade diagnostic cockpit for backend developers, database engineers, and tech leads. The visual tone is direct, mission-critical, and sober. The screen is treated as an active telemetry console: deep obsidian canvas (`slate-950`) with precision slate panels (`slate-900`) and crisp structural borders (`slate-800`).

The visual world strips away decorative flourishes to prioritize raw information density, execution plan readability, and unequivocal performance signals. Luminous signal colors—emerald (`#10b981`) for proven cost reductions and index-only scans, rose (`#f43f5e`) for critical sequential scan bottlenecks, and amber (`#f59e0b`) for ESR column orderings—act as precise instrument beacons on a dark radar.

**Key Characteristics:**

- Pure flat architectural depth with zero simulated shadows; hierarchy is dictated by background luminosity steps and 1px stroke boundaries.
- Refined and restrained component interactions where controls remain subordinate to SQL code and plan trees until actively engaged.
- Monospace-first data presentation for all schemas, queries, cost metrics, and ORM migrations.
- High-contrast, zero-bullshit information hierarchy adhering strictly to WCAG AA visibility.

## Colors

The palette is built on an ultra-dark slate foundation with semantic signal colors reserved exclusively for diagnostic telemetry.

### Primary

- **Emerald Signal** (`#10b981` / `#34d399`): Used exclusively to signify verified performance improvements, `Index Scan` / `Index Only Scan` nodes, healthy sandbox states, and active primary CTA states.

### Secondary

- **Bottleneck Rose** (`#f43f5e` / `#fb7185`): Highlights critical execution plan bottlenecks, unindexed sequential scans (`Seq Scan`), and hard syntax or sandbox rejections.
- **Warning Amber** (`#f59e0b` / `#fbbf24`): Denotes intermediate scan gains, candidate index warnings, and Equality-Sort-Range (ESR) column role assignments.

### Neutral

- **Slate Canvas** (`#020617`): Deepest background canvas for the application viewport.
- **Slate Surface** (`#0f172a`): Container surface for editors, cards, and execution plan diff panels.
- **Slate Surface Elevated** (`#1e293b`): Sub-panels, code blocks, active hover states, and keycap badges.
- **Slate Border** (`#1e293b`): 1px structural dividing lines between cards, columns, and headers.
- **Slate Border Focus** (`#334155`): Focus stroke for interactive SQL textareas and inputs.
- **Text Primary** (`#f1f5f9`): High-contrast white/slate for headings, active code, and primary values.
- **Text Secondary** (`#cbd5e1`): Standard body text and secondary labels.
- **Text Muted** (`#94a3b8`): Descriptive captions, character counters, and inactive tab labels.
- **Text Subtle** (`#64748b`): Inactive placeholders, shortcuts, and metadata stamps.

### Named Rules

**The Rarity of Emerald Rule.** Emerald is strictly an achievement color. It is never used for general decoration, background fills, or non-verified states. If emerald appears, PostgreSQL's optimizer has mathematically confirmed a cost improvement.

**The Semantic Signal Rule.** Rose, amber, and emerald are reserved exclusively for execution plan states (bottleneck $\to$ warning $\to$ improved). They are never applied arbitrarily to interface chrome.

## Typography

The typography pairs system sans-serif for interface controls with high-legibility monospace fonts for all database artifacts.

**Display Font:** System UI (`ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`)  
**Body Font:** System UI (`ui-sans-serif, system-ui, sans-serif`)  
**Label/Mono Font:** System Monospace (`ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace`)

**Character:** Utilitarian, sharp, and technical. The monospace type commands equal prominence with the UI typography to make SQL queries and JSON plans effortlessly scannable.

### Hierarchy

- **Display** (700, 1.25rem / 20px, line-height 1.2, tracking -0.025em): Header branding and primary result metric percentages (`-99.9%`).
- **Headline** (600, 1rem / 16px, line-height 1.4, tracking -0.015em): Section titles, modal titles, and vital sign card metrics.
- **Title** (600, 0.875rem / 14px, line-height 1.4, letter-spacing 0.05em uppercase): Panel labels, editor headers, and migration tab headers.
- **Body** (400, 0.875rem / 14px, line-height 1.5, normal tracking): Explanatory text, methodology notes, and error explanations. Max line length: 75ch.
- **Label** (500, 0.75rem / 12px, line-height 1.4, normal monospace): SQL textareas, execution plan tree nodes, request IDs, timing benchmarks, and kbd indicators.

### Named Rules

**The Code Equality Rule.** All SQL schemas, queries, planner costs, execution nodes, and migration outputs must render in monospace font. Never format raw database strings or numerical costs in proportional body fonts.

## Layout

IndexDoctor adopts a centered, max-width vertical layout engineered for intense single-task focus.

- **Container Width:** Constrained to `max-w-7xl` (1280px) on desktop, with fluid lateral gutters (`px-4 sm:px-6 lg:px-8`).
- **Two-Column Split:** Dual SQL editors split evenly (`grid-cols-1 lg:grid-cols-2`) on wide screens with a 16px (`gap-4`) gutter, stacking vertically on mobile viewports.
- **Vertical Spacing Rhythm:** Consecutive diagnostic cards follow an 8px / 16px / 24px vertical scale (`space-y-4` to `space-y-6`).
- **Responsive Floor:** The interface fully adapts down to 375px viewport width with no horizontal overflow; action bars convert to full-width stacked buttons and plan diff trees switch from multi-column comparison to vertically stacked before/after cards.

## Elevation & Depth

IndexDoctor enforces a **Pure Flat Architectural** elevation model.

There are zero drop shadows, zero blur filters, and zero lifted surfaces on stationary elements. Depth is established purely through background tone gradation:

1. Viewport canvas: `slate-950` (`#020617`)
2. Structural panels: `slate-900` (`#0f172a`)
3. Nested code blocks: `slate-900/80` or `slate-950/60`
4. Delineating boundaries: Crisp 1px `border-slate-800` (`#1e293b`) strokes.

### Named Rules

**The Zero-Drop Shadow Rule.** Cards and panels never cast drop shadows onto the canvas. Visual separation is achieved strictly through 1px border contrast and step-wise background luminosity shifts.

**The Sticky Border Rule.** Fixed elements like the top navigation bar use translucent `bg-slate-950/80` with a 1px `border-b border-slate-800` to anchor content without creating simulated z-plane elevation.

## Shapes

The form language is disciplined, rectangular, and subtly softened at the corners to maintain a contemporary developer-tool aesthetic.

- **Containers & Editors (`rounded-xl` / 12px):** Used for code editor boxes, action bar panels, and plan comparison containers.
- **Hero & Vital Sign Cards (`rounded-2xl` / 16px):** Used for the primary diagnosis outcome card to establish clear containment.
- **Inner Elements & Tabs (`rounded-md` / 6px to `rounded-lg` / 8px):** Used for tab selectors, code blocks, and editor sub-headers.
- **Pills & Badges (`rounded-full` / 9999px):** Used for preset selection buttons, severity status chips, Cloud Run environment tags, and health indicators.

## Components

Interactive components are refined and restrained, staying quiet at rest and responding decisively when hovered or pressed.

### Buttons

- **Shape:** `rounded-xl` (12px)
- **Primary Action (Diagnose):** Luminous emerald-500 gradient background, dark slate-950 text (`font-semibold text-sm`), active press scale (`active:scale-[0.98]`). Inactive/empty state transitions to muted `bg-slate-800 text-slate-500 border border-slate-700`.
- **Secondary / Reset:** Monochromatic slate-900 surface with slate-800 border and slate-400 text, brightening to slate-200 on hover.
- **Cancel Button:** Rose-950/30 surface with rose-500/40 border, rose-300 text, and a rotating spinner indicator.

### Chips & Presets

- **Shape:** `rounded-full` (9999px)
- **Default Preset:** Slate-900 surface with subtle slate-800 border and slate-400 text (`px-3 py-1.5 text-xs font-medium`).
- **Selected Preset:** Emerald-950/60 surface with emerald-600/80 border and emerald-300 text.
- **Severity Chips:** Translucent pill background with colored border:
  - Critical: `bg-rose-950/60 border-rose-700/60 text-rose-300`
  - High: `bg-orange-950/60 border-orange-700/60 text-orange-300`
  - Moderate: `bg-amber-950/60 border-amber-700/60 text-amber-300`
  - Optimal: `bg-emerald-950/60 border-emerald-700/60 text-emerald-300`

### Cards / Containers

- **Corner Style:** `rounded-2xl` (16px)
- **Background:** `bg-slate-900` (`#0f172a`)
- **Border:** 1px `border-slate-800` (`#1e293b`)
- **Internal Padding:** `p-5` (20px)

### Inputs / Textareas

- **Style:** Monospace textarea with `bg-transparent` over `bg-slate-900/80`, 1px `border-slate-800`, text-slate-100, and character count indicator in the sub-header.
- **Focus:** `focus-within:border-slate-700 focus-within:ring-1 focus-within:ring-slate-700`.

### Navigation / Tabs

- **Migration Tabs:** Segmented tab control inside a slate-900 housing. Active tab receives an emerald-500 fill with slate-950 text (`bg-emerald-500 text-slate-950`); inactive tabs remain slate-400 text.
- **Copy Button:** Integrated copy control with 2-second checkmark announcement (`Copied!`).

## Do's and Don'ts

### Do:

- **Do** format all execution costs, query texts, schema definitions, and migration snippets in monospace font.
- **Do** maintain a strict 1px border separation between adjacent dark slate containers.
- **Do** preserve emerald exclusively for verified planner improvements and active successful recommendations.
- **Do** test all layout changes against 375px mobile viewports to guarantee zero horizontal scroll.
- **Do** display the honesty disclaimer alongside planner costs ("estimated cost on simulated 500,000 rows — not a benchmark").

### Don't:

- **Don't** add decorative box shadows, glossy skeuomorphic bevels, or colored ambient drop shadows.
- **Don't** use generic red/green/yellow colors; use the calibrated slate-950/emerald-400/rose-400/amber-400 palette.
- **Don't** render unverified cost numbers in emerald; unverified or non-improved outcomes must stay in amber or neutral tones.
- **Don't** hide SQL errors or execution warnings behind generic error alerts; render PostgreSQL line numbers and AST gate rejection reasons verbatim.
- **Don't** introduce multi-page navigation or modal traps; keep IndexDoctor as an immediate single-page diagnostic cockpit.
