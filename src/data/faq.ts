export interface FaqItem {
  q: string;
  /** Plain text (also used for the FAQPage structured data). */
  a: string;
}

export const FAQ: FaqItem[] = [
  {
    q: 'How do I test a video file?',
    a: 'Drag your video onto the circle at the top of this page, or click it to browse. The tester reads the file locally, loads it into your browser’s own video player, reads the metadata, waits for decoded frames and then plays a short stretch of the video. If the playback clock advances and frames are decoded, the video is playable in this browser.',
  },
  {
    q: 'Why won’t my MP4 file play?',
    a: 'MP4 is only a container. The video inside can use H.264, H.265/HEVC, AV1, MPEG-4 Part 2 and more. Browsers play H.264 almost everywhere, but HEVC depends on the browser, the operating system and hardware decoding. An MP4 can also be incomplete — for example a phone recording that was interrupted — in which case the index that describes the frames is missing. The tester shows the codec it found and what went wrong.',
  },
  {
    q: 'Why does a video work in VLC but not in Chrome?',
    a: 'VLC ships with its own decoders for hundreds of formats. Browsers deliberately support a much smaller set of containers and codecs (mainly MP4 and WebM with H.264, VP9, AV1, AAC and Opus) and rely on the operating system for some of them. So AVI, WMV, FLV, MPEG-2 or ProRes files often play in VLC but not in a browser — the file is fine, the browser just can’t decode it. Converting to MP4 with H.264 video and AAC audio fixes this in almost all cases.',
  },
  {
    q: 'How do I check if a video link can be played on any website?',
    a: 'Switch to the “Video URL” tab and paste a direct link to the video file. The tester loads it into a <video> element from this page — exactly as another website would — and checks that it loads, decodes and really plays, that it works without cookies through a cross-origin (CORS) request, and that seeking works. “Open access” means any site can play it, including JavaScript players. “Playable, with limits” means a plain <video> tag works but the server does not send CORS headers. Links to YouTube or Vimeo pages are not video files and can only be embedded with their own players.',
  },
  {
    q: 'Is my video uploaded to a server?',
    a: 'No. The file is opened with a local object URL (URL.createObjectURL) that only exists inside your browser tab. Nothing is uploaded, and the page’s security policy blocks every way a page can send data (fetch, XHR, beacons, form posts), so the file cannot be sent anywhere. The object URL is released as soon as you clear the file or pick another one.',
  },
  {
    q: 'Which video formats do browsers support?',
    a: 'Every modern browser plays MP4 with H.264 video and AAC audio. WebM with VP8 or VP9 and Opus is supported by Chrome, Edge, Firefox and recent Safari. AV1 is supported by most current browsers on capable hardware. H.265/HEVC works in Safari, and in Chrome or Edge when the device has a hardware decoder. AVI, WMV, FLV and MPEG-1/2 are generally not supported.',
  },
  {
    q: 'What is the difference between a video container and a codec?',
    a: 'The container is the file format — MP4, MOV, MKV, WebM or AVI. It packs video, audio and subtitle streams together with timing information. The codec is how each stream is compressed — for example H.264, HEVC, VP9 or AV1 for video and AAC or Opus for audio. A browser must understand both the container and the codecs inside it to play a file, which is why two MP4 files can behave differently.',
  },
  {
    q: 'Does “Video is playable” mean it plays everywhere?',
    a: 'It means this browser, on this device, could load and play the file. Another browser or operating system may have different codec support, so for important files test in every browser your audience uses. MP4 with H.264 and AAC is the safest choice for the web.',
  },
  {
    q: 'Can this tool tell if my video is corrupted?',
    a: 'It can show strong evidence — for example an MP4 whose index is missing, or a file whose sections claim more bytes than it contains. But a browser cannot always tell damage apart from an unsupported codec, so the tester reports what it saw (“could not be played by this browser”) rather than declaring a file definitely broken.',
  },
];
