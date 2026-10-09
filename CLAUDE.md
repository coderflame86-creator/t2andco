# CLAUDE.md — T2&Co

## Purpose

T2&Co is a business website for three product lines:

1. **J-Beauty skincare** (main focus): Japanese skincare products
2. **Pink Himalayan salt**
3. **Japanese car imports**

Brand colours: white `#FFFFFF`, aqua mist `#CAF0F8`, platinum `#D9DDE1`, maroon `#7A1C2E`. Tone: warm and minimal. The logo is a serif "T2 | &Co" wordmark.

**Design system:** read `design-system/t2co/MASTER.md` before any UI work. It defines the colour tokens, type (Playfair Display + Inter), spacing, components and motion. Check `design-system/t2co/pages/<page>.md` for page overrides.

## Architecture

```
frontend/   Static site: index.html, styles.css, app.js (plain HTML/CSS/JS)
backend/    Server and API code (not built yet)
data/       Product and catalog data (e.g. JSON)
prompts/    AI prompts for product copy and content
```

- The frontend reads product data from `data/` or from the backend API.
- The backend serves the data and will handle enquiries and orders later.
- Keep the three product lines separate in data and UI. Skincare comes first.

## Scope rule

**Only change the files the current task needs.** Do not refactor, reformat, rename or "improve" anything else. If you spot an unrelated issue, mention it instead of fixing it. Do not create files the task does not ask for.

## Coding rules

- Use plain HTML, CSS and JavaScript. Do not add frameworks or dependencies unless asked. Google Fonts is the only approved external resource.
- Use semantic HTML, a mobile-first responsive layout, and accessible markup (alt text, labels, contrast).
- Use the design tokens (CSS variables) at the top of `styles.css`. Never hardcode hex colours in components.
- Shared header/footer markup is copied in all 8 pages. When you change it, change every page.
- J-Beauty categories, in this order: Anti-aging & Collagen, Hydration & Skin Firming, Brightening. Masks and Eye Cream & Blackheads were removed.
- Keep functions small, use clear names, and write few comments.
- Keep product content in `data/`, not hardcoded in HTML or JS.
- Match the style of the code around your change.

## Security rules

- Never commit secrets, API keys or passwords. Use environment variables and a `.env` file that git ignores.
- Validate and sanitize all user input, both in the browser and on the server.
- Do not use `innerHTML` with user or external data. Use `textContent` or escape the data first.
- Use HTTPS. Do not put personal data in URLs or query strings.
- Do not store payment card details. Use a trusted payment provider.
- Car import listings must not include personal owner data (for example, the full VIN tied to an owner's identity).

## Token-saving rules

- Read only the files the task needs. Use search instead of opening whole folders.
- Do not re-read a file you just edited.
- Keep answers short. List what changed instead of pasting whole files.
- Do not repeat this file or the README back to the user.
- Ask one question if the task is unclear. Do not guess at large changes.
