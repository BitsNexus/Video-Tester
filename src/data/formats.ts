/**
 * Formats listed on the page. `probe` is what the "Your browser" column asks `canPlayType()` —
 * a hint about the type only; the tester is what checks a real file.
 */
export interface VideoFormat {
  name: string;
  extensions: string;
  container: string;
  codecs: string;
  typical: string;
  /** Typical browser support, used for the badge. */
  support: 'good' | 'mixed' | 'poor';
  probe: string;
}

export const FORMATS: VideoFormat[] = [
  {
    name: 'MP4',
    extensions: '.mp4',
    container: 'MPEG-4 Part 14',
    codecs: 'H.264, H.265/HEVC, AV1 · AAC, Opus',
    typical: 'Plays in every modern browser with H.264. HEVC depends on browser and hardware.',
    support: 'good',
    probe: 'video/mp4; codecs="avc1.42E01E, mp4a.40.2"',
  },
  {
    name: 'WebM',
    extensions: '.webm',
    container: 'WebM (Matroska subset)',
    codecs: 'VP8, VP9, AV1 · Opus, Vorbis',
    typical: 'Chrome, Edge, Firefox and Opera. Safari supports most WebM on recent versions.',
    support: 'good',
    probe: 'video/webm; codecs="vp9, opus"',
  },
  {
    name: 'MOV',
    extensions: '.mov, .qt',
    container: 'QuickTime',
    codecs: 'H.264, HEVC, ProRes',
    typical: 'Safari plays most. Other browsers play MOV files that contain H.264, but not ProRes.',
    support: 'mixed',
    probe: 'video/quicktime',
  },
  {
    name: 'M4V',
    extensions: '.m4v',
    container: 'Apple MPEG-4',
    codecs: 'H.264, HEVC · AAC',
    typical: 'Treated like MP4. DRM-protected iTunes purchases will not play.',
    support: 'good',
    probe: 'video/mp4',
  },
  {
    name: 'MKV',
    extensions: '.mkv',
    container: 'Matroska',
    codecs: 'Almost anything',
    typical: 'Varies. Chromium browsers often play MKV with H.264/VP9 + AAC/Opus; others may not.',
    support: 'mixed',
    probe: 'video/x-matroska',
  },
  {
    name: 'OGV',
    extensions: '.ogv, .ogg',
    container: 'Ogg',
    codecs: 'Theora · Vorbis, Opus',
    typical: 'Firefox. Support for Theora video is being removed from other browsers.',
    support: 'mixed',
    probe: 'video/ogg; codecs="theora, vorbis"',
  },
  {
    name: '3GP',
    extensions: '.3gp, .3g2',
    container: '3GPP (MP4-based)',
    codecs: 'H.263, H.264 · AMR, AAC',
    typical: 'Plays when it uses H.264 + AAC. Old phone videos with H.263/AMR usually do not.',
    support: 'mixed',
    probe: 'video/3gpp',
  },
  {
    name: 'AVI',
    extensions: '.avi, .divx',
    container: 'Audio Video Interleave',
    codecs: 'Xvid, DivX, MJPEG, H.264 · MP3, AC-3',
    typical: 'Not supported by web browsers. Convert to MP4 to play it online.',
    support: 'poor',
    probe: 'video/x-msvideo',
  },
  {
    name: 'WMV',
    extensions: '.wmv, .asf',
    container: 'Advanced Systems Format',
    codecs: 'WMV 7/8/9, VC-1 · WMA',
    typical: 'Not supported by web browsers.',
    support: 'poor',
    probe: 'video/x-ms-wmv',
  },
  {
    name: 'MPEG',
    extensions: '.mpg, .mpeg, .vob',
    container: 'MPEG program stream',
    codecs: 'MPEG-1, MPEG-2 · MP2, AC-3',
    typical: 'Not supported by most browsers.',
    support: 'poor',
    probe: 'video/mpeg',
  },
  {
    name: 'TS / M2TS',
    extensions: '.ts, .mts, .m2ts',
    container: 'MPEG transport stream',
    codecs: 'H.264, HEVC, MPEG-2 · AAC, AC-3',
    typical: 'Safari (as HLS segments). Other browsers need it remuxed to MP4.',
    support: 'poor',
    probe: 'video/mp2t',
  },
  {
    name: 'FLV',
    extensions: '.flv, .f4v',
    container: 'Flash Video',
    codecs: 'Sorenson, VP6, H.264',
    typical: 'Not supported since Flash was retired. F4V is MP4-based and may play.',
    support: 'poor',
    probe: 'video/x-flv',
  },
];

/** MIME/codec strings shown in Technical Details → canPlayType(). */
export const CAN_PLAY_PROBES = [
  'video/mp4',
  'video/mp4; codecs="avc1.42E01E, mp4a.40.2"',
  'video/mp4; codecs="hvc1.1.6.L93.B0"',
  'video/mp4; codecs="av01.0.05M.08"',
  'video/mp4; codecs="vp09.00.10.08"',
  'video/webm',
  'video/webm; codecs="vp8, vorbis"',
  'video/webm; codecs="vp9, opus"',
  'video/webm; codecs="av01.0.05M.08, opus"',
  'video/ogg; codecs="theora, vorbis"',
  'video/quicktime',
  'video/x-matroska',
  'video/3gpp',
  'video/x-msvideo',
  'video/x-ms-wmv',
  'video/mpeg',
  'video/mp2t',
  'application/vnd.apple.mpegurl',
  'video/x-flv',
];
