# Spec: the "AI Reel" look (from the Instories ad)

Source: Instories ad reel `instagram.com/p/DdHNwMoAIhm`, studied frame by frame on 10 Nov 2026. It shows a split screen: "Your photos" on the left, "AI Reel in one tap" on the right. This spec describes what the right side does, compares that with what the `feat/beat-templates` branch already does, and lists what to build. It's written for the next build session.

## What the reel does

| # | Technique | What you see | Kind |
|---|---|---|---|
| 1 | Beat-synced micro-cuts | Shots last about 0.3–0.5 s, and every cut lands on a beat. Video clips are cut just as short as photos. | Editing |
| 2 | Motion on every shot | No frame is still. Every shot pushes in, pans or flies over. | Editing (photos) / AI (see 5) |
| 3 | Whip / zoom transitions | Shots smear sideways with motion blur or zoom into the next one (e.g. boat → street). | Editing |
| 4 | One punchy grade | Warm highlights, saturated teal-blue skies and water, lifted contrast. A flat grey temple turns glowing amber. | Editing |
| 5 | Generated camera moves | Some shots aren't in the photos at all. A street photo of a bell tower becomes a drone shot pulling back over the rooftops, and a temple corridor becomes a dolly through a doorway. This is AI image-to-video, Instories' "Photo → video" mode. | Generative AI |

Instories' own help page lists the modes behind it: Music Video (picks the best moments and cuts them to the music), AI Transitions, Photo → video, and Remake Video. Generating takes a couple of minutes and returns several options, and reels are capped at 180 s. The ad's "one tap" leaves those out.

## Already in `feat/beat-templates` (v0.3.0)

- Beat detection with tempo, phase and the drop, plus a 120 BPM fallback (`js/beats.js`). Covers #1 for photos.
- Beat Drop: punch-in/pull-out on every cut and an RGB split. Covers part of #2 and #3.
- Journey: a directional motion-blur smear between shots. Covers #3 (whip).
- Cinematic Memory: amber grade, film grain, letterbox. Close to #4, but warm only.

## Gaps to build, in priority order

### G1. "AI Reel" template: micro-cuts for video too
- New template `aireel`: photos `[0.3, 0.45, 0.7]` s, video `[0.35, 0.5, 0.9]` s, `unitBeats: 1`, hard cuts plus whip/zoom transitions with an 0.12 s blur overlap centred on the beat.
- For video, take several short **best moments** from one clip instead of one long run. Score each 0.5 s window by motion (frame-difference energy) and sharpness (Laplacian variance on a downscaled frame). Skip blurry or near-static windows and take the top-scoring, non-overlapping ones in clip order.
- Test: every cut midpoint is within 0.03 s of a beat; no two windows from the same clip overlap; a clip shorter than 0.35 s is skipped rather than shortening the reel.

### G2. Always-moving photos
- Every photo gets a continuous move for its whole time on screen: push-in, pull-out, or a pan along the image's long axis. Use eased 6–10% scale and pick the move per photo with the existing `hash()` so a re-render looks the same.
- Alternate the direction between neighbouring shots, so a pan left is followed by a push or a pan right. That's what makes whips read as continuous motion.

### G3. Transition set: whip-left, whip-right, zoom-through
- Reuse Journey's `smear()` for whips. Zoom-through scales the outgoing shot up 1.0→1.6 with radial blur while the incoming one scales 1.4→1.0.
- Pick the transition to match the motion: a whip follows the direction of the outgoing pan, and zoom-through follows a push-in.

### G4. "Vivid" grade (teal-orange)
- A second grade next to Cinematic's amber: warm highlights, cool shadows, +15% saturation, and blues/cyans pushed toward teal.
- Keep it cheap on iPhone: no canvas `filter`. Use a per-pixel lookup table (a small 3D LUT as a 33³ texture, or a per-channel curve) applied to a downscaled buffer, or precomputed once per photo at import.

### G5. 2.5D parallax on photos (on-device, optional) — the private answer to #5
- Estimate depth on the phone with transformers.js `depth-estimation` (Depth Anything small). Split the photo into 2–3 depth layers and move them at different speeds for a drone-like push.
- It downloads once and is cached, like the Whisper model, so nothing leaves the phone.
- Fall back to G2 if the model fails to load or the phone is too slow (budget about 1.5 s per photo at import).
- CLAUDE.md currently allows the transformers.js CDN load only when captions are on. G5 needs that rule widened to "captions or parallax on", so get Vinu's OK when picking up G5.

### G6. Generative "Cinematic shot" (cloud, opt-in) — **needs Vinu's decision first**
- True image-to-video (Higgsfield / Kling) gives real drone and dolly moves, but it **uploads the photo**. That breaks this repo's rule that photos and videos never leave the phone (CLAUDE.md).
- If Vinu approves it: off by default; at most 2–3 hero photos per reel, picked by him; still previews before any generation; a cost shown per clip; the generated clip clearly marked; and no faces of the kids sent without his say-so.
- Until he decides, build G1–G5 only.

## Done when
- `aireel` renders a 30 s reel from the test fixtures where every cut is on the beat (unit test) and frames show the moves, whips and the vivid grade (frame strip in `test/out/`).
- The existing tests and adversarial scripts still pass, and `VERSION` is bumped.
- A PR is opened and not merged. Vinu merges after review and a test on his phone.
