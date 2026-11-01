# Reel Studio

A personal iPhone home-screen web app for turning family photos and clips into short vertical reels (1080 × 1920): a title card, music, crossfades, auto-captions and pause trimming. Photos and videos never leave the phone. Everything renders in the browser.

## Use it

1. Open the GitHub Pages link in Safari on the iPhone, then Share → **Add to Home Screen**.
2. Add photos and clips, reorder them, set the title, pick a track from Files.
3. On a talking clip, tap **Captions** or **Cut pauses**. The first time, a ~40 MB speech model downloads and stays cached.
4. **Make video** → **Save to Photos** → "Save Video".

## v1 limits

- Reels are capped at 60 s, with at most 20 s taken from any one clip.
- One template ("Postcard").
- Captions are English only (Whisper tiny.en).
- Music has to be your own or royalty-free audio from Files. Apple Music tracks are DRM-locked.

## How it works

| File | Job |
|---|---|
| `js/timeline.js` | Pure logic: ordering, crossfades, pause trimming, caption cues (unit-tested) |
| `js/render.js` | Draws one frame of the Postcard template on a canvas |
| `js/audio.js` | Offline mix: music loop, fades, ducking under talking clips, clip audio cut to match |
| `js/export.js` | WebCodecs H.264 + AAC → MP4 (mp4-muxer), falling back to a real-time MediaRecorder capture |
| `js/player.js` | Real-time preview |
| `js/captions.js` | On-device Whisper via transformers.js |

## Tests

```
node --test test/timeline.test.mjs                # logic
NODE_PATH=$(npm root -g) node test/e2e.mjs --opus # full export via WebCodecs (Chromium has no AAC encoder, so opus stands in)
NODE_PATH=$(npm root -g) node test/e2e.mjs        # whichever path the browser picks
```

The e2e test drives the app in an iPhone 14 profile, exports a reel, and checks it with ffprobe (resolution, codec, duration, audible sound). Frames are written to `test/out/`.
