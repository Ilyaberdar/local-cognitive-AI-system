# Brief: Local Cognitive videos

## Deliverables

| What | Format | Where it goes |
|---|---|---|
| Docs demos (D1–D8) | 1920×1080, 30 fps, H.264 MP4 plus a poster JPG. No sound. 15–45 s. Short on-screen labels in English. Under 8 MB each. | `docs-site/public/videos/<id>.mp4`, embedded in the matching page with `<video controls muted playsinline preload="none" poster=…>` |
| Promo | 1920×1080, 30 fps, 40 s. H.264 MP4 at about 4 Mbps, about 20 MB. Optional WebM/AV1. English voice-over. Subtitles burned in, plus a `.vtt` file. | Landing `public/media/promo-v1.mp4` with a long-cache `_headers` rule, and the docs home page |
| Masters | ProRes or lossless renders of everything | `out/` only, never in git |

**Hosting limits**

- Cloudflare Pages and Workers serve files up to **25 MiB** each.
- The landing's CSP allows only same-origin media: `default-src 'self'` and no `media-src`. So the promo is self-hosted. YouTube and Vimeo are blocked unless `_headers` is changed.
- The landing allows no inline scripts or styles. Video behaviour goes in `landing.js` and styling in `site.css`, followed by `npm run stamp`.
- The landing's local `server.mjs` has no MIME type for video and no Range support. Test playback with `npx wrangler pages dev public`.

## Rules for honest footage

1. **Everything inside the app window is a recording of the real app doing the real action:**
   - real models, real downloads, real workflow runs, real checks;
   - no prepared answers, no edited model output, no drawn statuses.
   - Re-taking a shot until a good answer comes is fine. Changing what the answer says is not.
2. **Waiting time may be cut, but it is always marked.**
   - Every sped-up or cut stretch carries the `<SpeedBadge>` above the window for the whole stretch, saying how much was cut ("Sped up 8×", "Download shortened: 1 min 40 s → 4 s").
   - Subtitles never imply the action was faster than it was.
3. **Editorial layers are only these:** title cards, subtitles, callouts that name the part of the interface being shown, zooms, crossfades and the speed badge.
   - A callout never states a result the recording does not show.
4. **The landing's animated mock windows** (`landing.js` chat, workflow and Synthesis motions) are illustrations. They are never used as footage or presented as the app.
5. **Setup is allowed and disclosed in the shot list:** seeding an example project or workflow through the API, or importing a model before the shot. The result shown must come from the run being recorded.
6. **Privacy:**
   - Recordings use an isolated data folder (`.profiles/<shot>`), never the owner's own profile, which has personal chats, an avatar and models with unsuitable names.
   - No keys, e-mail addresses, IP addresses or private paths on screen. Paths should be neutral, e.g. `~/Demo/…`.

## Visual style

The style is a clean product presentation. It shows the real interface, keeps details large and readable, zooms in calmly and uses short captions.

**Frame**
- The landing page's look: background `#f6f7f9` with 1.5 px dots every 30 px (`#dde2ea`).
- Ink `#10131a`, accent `#2f55c8`.
- Geist for text and Geist Mono for small labels (the landing's own font files).

**App window**
- A real recording, 1440×900 at 16:10, centred.
- 22 px radius and the landing's soft window shadow.
- The macOS traffic lights are not drawn.
- The app is recorded at 1600×1000 points on Retina (3200×2000 pixels), so zooming up to 2× stays sharp.

**App theme**
- **Light, with text size 115%.** It matches the landing, and the bigger text keeps the interface readable at 720 px wide in the docs. Pending owner confirmation.
- Behind a translucent sidebar the window shows the app's light background `#e9edf2`.

**Title cards**
- Mono eyebrow at 30 px in the accent colour, headline Geist 600 at 96 px.
- Optionally the logo, built from `icon.png` at 1254 px.

**Subtitles**
- In the band under the window, so they never cover the interface.
- Geist 500, 40 px, ink colour, centred, at most 2 lines.

**Motion**
- Zooms of 1.0→1.3–1.8 over 1.5–2.5 s with `Easing.bezier(0.45, 0, 0.2, 1)`, holding still while the viewer reads.
- Crossfades of 10–12 frames between scenes.
- No bounces, spins or particles.

**Callouts**
- A white chip with a 4 px accent edge, Geist 500 at 30 px, at most 6 words.

**Speed badge**
- A white pill above the window's top-right corner with a ⏩ icon in the accent colour and plain text.

**Reference frames:** `npx remotion still StyleTitle | StyleShot | StyleEnd`, and `StyleMotion` in Studio.

## Sources read

**App:** `README.md`, `CHANGELOG.md`, `public/assets/liquid-glass.css` (theme tokens), `electron/main.cjs` (window, data folder, `LOCAL_COGNITIVE_TEST_DATA_DIR`), `electron/launch-guard.cjs` and `examples/`.

**Docs** (`docs-site/src/content/docs`):
- Astro 7 and Starlight 0.42, accent colours from the app (`src/styles/theme.css`).
- No custom components and no video yet. Screenshots come from `images/` through `scripts/sync-content.mjs`.
- Style: plain short sentences addressed to "you", UI labels in **bold**, `→` for menu paths, limits stated honestly.

**Landing** (`local-cognitive-landing`):
- Plain HTML, CSS and JS in `public/`; Geist and Geist Mono self-hosted, light only.
- CSP in `_headers`; Cloudflare Pages deploys on push to `main`.

**Copy to reuse:**
- "Private AI on your own machines."
- "Agents you can watch, step by step."
- "Code that has to pass its contract."
- "Any model on the hardware you have."
- "One command on the server. One key in the app."
- "Your work stays on your machines."
