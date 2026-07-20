// Resolver for ffmpeg/ffprobe binaries. Python threads the managed-binary
// path through MONTAJ_FFMPEG / MONTAJ_FFPROBE (same idiom as MONTAJ_PYTHON);
// bare names fall back to PATH when unset.
export const FFMPEG = process.env.MONTAJ_FFMPEG || 'ffmpeg';
export const FFPROBE = process.env.MONTAJ_FFPROBE || 'ffprobe';
