# Local Cognitive videos

Product videos for Local Cognitive: short feature demos for the docs and a 40-second promo for the landing page. This is a separate Remotion project with its own dependencies; nothing here is part of the app or its builds.

Start with `handoff/status.md` (state, blockers, next step), then `handoff/brief.md` (rules and style) and `handoff/shot-list.md`.

```bash
npm ci
npm run dev -- --port 3123   # Remotion Studio
npx tsc --noEmit && npx eslint src
```

Recordings come from the app's development build driven by Playwright (`scripts/capture/`), each with its own data folder in `.profiles/`. Raw captures, audio and renders stay out of git (`public/captures`, `public/audio`, `out`). Remotion is free for teams of up to three people; a larger company needs a Remotion company licence.
