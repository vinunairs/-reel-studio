# Reel Studio: notes for Claude

Personal iPhone PWA for Vinu's family reels. It's static (GitHub Pages) with no build step and no server. Photos and videos must never be uploaded anywhere.

## Rules
- Keep it static: plain ES modules, vendored libs in `vendor/`. The only runtime CDN load is transformers.js plus its model, and only when captions are turned on.
- `js/timeline.js` stays pure (no DOM). Every logic change gets a test in `test/timeline.test.mjs` that fails when the change is reverted.
- Bump `VERSION` in `js/app.js` on every user-visible change. It shows in Diagnostics, so Vinu can confirm his phone runs the new code (force-quit = app-switcher swipe).
- iPhone rules: every screen is a normal scrolling page, the header is sticky with a fixed height, safe-area insets are respected, and `theme-color` = page background.

## Before calling a change done
1. `node --test test/timeline.test.mjs`
2. `NODE_PATH=$(npm root -g) node test/e2e.mjs --opus` (WebCodecs path) and `... e2e.mjs --force=realtime` (fallback path)
3. Regression scripts in `test/adversarial/` (races, sync, audio automation, bad files): run the ones your change touches. `sync.mjs` should report max |offset| ≤ 0.05 s on the WebCodecs path.
4. Look at `test/out/frames.png`-style frames and the editor screenshot yourself.
5. Work on a branch, open a PR, and don't merge. Vinu merges after an independent review and a test on his phone.
