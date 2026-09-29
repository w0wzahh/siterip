import mimeTypes from 'mime-types';

const CT_EXT: Record<string, string> = {
  'text/html': '.html',
  'text/css': '.css',
  'text/javascript': '.js',
  'application/javascript': '.js',
  'application/x-javascript': '.js',
  'application/json': '.json',
  'application/manifest+json': '.json',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/avif': '.avif',
  'image/svg+xml': '.svg',
  'image/x-icon': '.ico',
  'image/vnd.microsoft.icon': '.ico',
  'image/bmp': '.bmp',
  'font/woff': '.woff',
  'font/woff2': '.woff2',
  'font/ttf': '.ttf',
  'font/otf': '.otf',
  'application/font-woff': '.woff',
  'application/font-woff2': '.woff2',
  'application/x-font-woff': '.woff',
  'application/x-font-ttf': '.ttf',
  'application/vnd.ms-fontobject': '.eot',
  'audio/mpeg': '.mp3',
  'audio/ogg': '.ogg',
  'audio/wav': '.wav',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'application/pdf': '.pdf',
  'application/xml': '.xml',
  'text/xml': '.xml',
  'text/plain': '.txt',
  'text/vtt': '.vtt',
  'application/wasm': '.wasm',
};

/** Normalize a content-type header value to its bare mime type. */
export function baseContentType(header: string | undefined | null): string {
  return (header ?? '').split(';')[0].trim().toLowerCase();
}

/** Map a content type to a file extension (with leading dot), or '' if unknown. */
export function contentTypeToExt(contentType: string): string {
  const base = baseContentType(contentType);
  if (!base) return '';
  if (CT_EXT[base]) return CT_EXT[base];
  const ext = mimeTypes.extension(base);
  return ext ? '.' + ext : '';
}
