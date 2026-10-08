# T2&Co Design System — MASTER

Source of truth for all T2&Co front-end work. Page-specific overrides go in `pages/<page>.md`; if none exists, use this file only.
Implemented as CSS custom properties at the top of `frontend/styles.css`. Never hardcode raw hex values in components; use the tokens.

## Brand & tone

- **Tone:** warm and minimal. Generous whitespace, calm motion, few ornaments.
- **Style:** refined minimal e-commerce: white surfaces, soft aqua sections, thin platinum lines, maroon as the single action colour.

## Colour

| Token | Value | Use |
|---|---|---|
| `--white` | `#FFFFFF` | Page and card surfaces |
| `--aqua-mist` | `#CAF0F8` | Accents: icon tiles, eyebrow badges, hero glow, footer headings |
| `--platinum` | `#D9DDE1` | Borders and dividers |
| `--maroon` | `#7A1C2E` | Primary: buttons, links, active states, footer, CTA band |
| `--color-primary-hover` | `#5F1523` | Hover/pressed for maroon; footer background (separates it from the maroon CTA band) |
| `--color-primary-tint` | `#F6ECEE` | Hover wash behind maroon text |
| `--color-surface-alt` | `#EEFAFD` | Large tinted section backgrounds (soft aqua) |
| `--color-text` | `#1F2328` | Body and headings |
| `--color-text-muted` | `#4B5563` | Secondary text (7.5:1 on white) |
| `--color-border-strong` | `#8C939B` | Form control borders (3:1 on white) |
| `--color-error` | `#B42318` | Form errors |

Verified pairs: maroon on white 10.4:1 · white on maroon 10.4:1 · maroon on aqua mist 8.5:1 · aqua mist on maroon 8.5:1 · muted on soft aqua 7.1:1.
Rule: aqua mist and platinum are never used for text on white.

## Typography

- **Display:** Playfair Display 500–700 (headings, product names, prices of note). Fallback: Georgia.
- **Body:** Inter 400/500/600. Fallback: system-ui.
- Loaded from Google Fonts with `display=swap` (preconnect in each page `<head>`).
- Scale: 12 · 14 · 16 · 18 · 20 · 24 · fluid 2xl/3xl/4xl (`clamp()`), body 16px, line-height 1.6 (long-form 1.75).
- Headings use `text-wrap: balance`; prices use tabular figures.
- Eyebrows: Inter 600, 12px, uppercase, 0.14em tracking, maroon on aqua pill.

## Spacing, radius, elevation

- 4/8 spacing scale: `--space-1` (4px) to `--space-9` (96px). Section padding `--section-y` is fluid from 64 to 96px.
- Container max 1200px; gutters 16 / 24 / 32px by breakpoint.
- Radius: 8 (controls), 12 (inputs, panels), 20 (cards), pill (buttons, chips, badges).
- Shadows: `--shadow-sm` (resting), `--shadow-md` (raised), `--shadow-lg` (hover/dropdowns). No other shadow values.
- Z-index: header 100, dropdown 110, skip link 1000.

## Components

- **Buttons:** pill, min-height 48px (44px header CTA, 56px large). Primary = maroon fill; outline = maroon border. Hover darkens, press scales to 0.98. Only one primary CTA per view; on the maroon CTA band the button inverts to white.
- **Cards:** white, 1px platinum border, 20px radius. Hover (pointer devices only) lifts 4px with `--shadow-lg`.
- **Navigation:** sticky white header. Desktop (≥960px): dropdowns open on hover and keyboard focus, active item gets a maroon underline, parent highlights via `:has()`. Mobile: CSS-only drawer with 48px rows; sub-menus shown indented.
- **Breadcrumbs:** on all product pages (3-level hierarchy).
- **Category chips:** on J-Beauty pages to switch between the 5 categories; current chip filled maroon.
- **Forms:** visible labels, maroon asterisk on required fields, hint text via `aria-describedby`, 48px inputs, error text shown with `:user-invalid` (no JS), native validation kept.
- **FAQ:** native `<details>`, plus icon rotates to ×, open item gets maroon border.

## Motion

- Tokens: fast 150ms, base 250ms, slow 600ms; easing `cubic-bezier(.22,1,.36,1)`.
- Only transform/opacity animate. The only animations are the collection cards fading up on load and hover/press feedback. The scrolling marquee was removed at the owner's request; don't re-add it.

## Hero

- Right column holds the product photo `assets/images/hero-products.jpg` (16:9, 2000×1125). It fills the column's full width, with 20px radius and `--shadow-lg`. It loads with `fetchpriority="high"` and is never lazy-loaded.
- Desktop: copy and image split 50/50. Mobile: the image sits full-width below the CTA.
- Everything is disabled under `prefers-reduced-motion`.

## Breakpoints (mobile-first)

`640px` (2-col grids) · `960px` (desktop nav, split hero, contact 2-col) · `1024px` (4-col audience, 4-col footer).

## Accessibility checklist

Skip link · visible 3px maroon focus ring · 44px+ targets (24px min for inline footer links) · named menu toggle · sequential headings · decorative art `aria-hidden` · `prefers-reduced-motion` · no horizontal scroll at 360px.

## Audit log

**2026-10-08: UI/UX Pro Max audit of v1.** Fixes applied in v2:
1. New brand palette (white / aqua mist / platinum / maroon) replacing blush/cream.
2. Web fonts (Playfair Display + Inter) replacing Georgia/system; fluid type scale.
3. Tokenised spacing, radius, shadow, z-index and motion; CSS rewritten mobile-first.
4. Menu toggle had no accessible name (label was named, not the checkbox). Fixed.
5. Footer links 21px tall, under the 24px minimum. Fixed.
6. Excess motion (glowing sun, three floating icons, spinning rings) reduced to calm essentials.
7. No location cues on deep pages: added breadcrumbs and J-Beauty category chips.
8. Desktop nav had no active-section indicator for product pages. Added an underline via `:has()`.
9. Contact form: added required markers, a phone hint and inline error messages.
10. Section rhythm: alternating white / aqua sections, maroon closing CTA band.

Open items (need business input or JS): real product photos, real contact details, "Order Now" behaviour, form confirmation message.
