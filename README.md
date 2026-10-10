# Video File Tester

Checks whether **this browser** can actually load, decode and play a local video file — entirely client-side.
Live target: https://bitsnexus.github.io/VideoTester/ (a BitsNexus sub-site).

Astro 7 + Tailwind 4 + TypeScript, styled after limewire.com (DM Sans, dark green hero, circular drop zone).

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Dev server (`/VideoTester/`) |
| `npm run build` / `npm run preview` | Production build (with CSP) and preview |
| `npm run check` | Astro/TypeScript diagnostics |
| `npm test` | Unit tests for header sniffing, diagnoses, formatting and the report |

## How playback is verified

1. The file's first 1 MB is read locally to name the container/codecs (`src/lib/sniff.ts`) — only used to explain results.
2. A `blob:` URL (`URL.createObjectURL`) is assigned to a `<video>`; the tester waits for `loadedmetadata`, then `loadeddata`.
3. `video.play()` is called (muted for the automatic run). The test passes only when `currentTime` advances ≥ 1.5 s
   (or the whole clip, if shorter) **and** decoded frames are reported (`requestVideoFrameCallback` / `getVideoPlaybackQuality`).
4. `NotAllowedError` = autoplay blocked → "partially tested" + Start Playback Test button, never "broken".
5. Object URLs are revoked on Clear, on a new file and on `pagehide`.

## URL checker ("Is this video open to play on any site?")

The **Video URL** tab loads a link the way another website would (`src/lib/url-test.ts`):

1. Plain `<video src>` (no `crossorigin`) → the link loads, decodes and `currentTime` advances with frames decoded.
2. A second, hidden `<video crossorigin="anonymous">` probe → the server sends CORS headers and needs no cookies.
3. A seek to the middle → the server supports range requests.

Verdicts: **Open access** (all pass over https), **Playable, with limits** (plays but no CORS, or http://),
**Not playable** (load/decode failed — with causes such as login/expired links, hotlink protection, page links, 404/403, codec),
**Partially tested** (autoplay blocked / tab hidden). Requests go straight from the browser to the video's server with no
Referer; nothing is proxied. YouTube/Vimeo/Drive/Dropbox page links get specific advice.

## Layout

- `src/lib/file-info.ts` — file handling, object URLs, header read
- `src/lib/sniff.ts` — bounded, defensive container/codec sniffer
- `src/lib/video-test.ts` — test engine (`loadVideo`, `testVideoPlayback`, `VideoTester`, …)
- `src/lib/media-errors.ts` — MediaError / play() mapping and diagnoses
- `src/lib/url-test.ts` — URL analysis, diagnoses and the `UrlTester`
- `src/lib/report.ts` — copy/download text reports (file and URL)
- `src/scripts/app.ts` / `url-app.ts` — UI for the file tester / URL checker
- `src/scripts/dom.ts`, `modes.ts` — shared DOM helpers and the file/URL tabs
- `src/components/*` — hero drop zone, workspace, info sections

## Privacy

The CSP (`astro.config.mjs`) sets `connect-src 'none'` and `form-action 'none'`, so the page cannot send data anywhere; a local file never leaves the browser. `media-src` allows `https:`/`http:` only so the URL checker's `<video>` elements can stream the link the user entered.
