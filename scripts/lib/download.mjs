import { createWriteStream } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const megabytes = (bytes) => Math.round(bytes / 1048576);

/**
 * Downloads `url` into `file`. A slow connection takes as long as it needs; a download that receives
 * nothing for `stallMs` (the wait for the answer included) is given up. While it lasts, the progress
 * is printed every `progressMs`.
 */
export async function download(url, file, what, { stallMs = 60_000, progressMs = 15_000, log = console.log } = {}) {
  log(`Downloading ${what}`);
  const controller = new AbortController();
  let timer;
  const alive = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(new Error(`${what} download stopped: nothing arrived for ${Math.round(stallMs / 1000)} s.`)), stallMs);
  };
  alive();
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok || !response.body) throw new Error(`${what} download failed: HTTP ${response.status}`);
    const total = Number(response.headers.get('content-length')) || 0;
    let received = 0, shownAt = Date.now();
    const progress = new Transform({
      transform(chunk, _encoding, done) {
        alive();
        received += chunk.length;
        if (Date.now() - shownAt >= progressMs) {
          shownAt = Date.now();
          log(total ? `  ${megabytes(received)} of ${megabytes(total)} MB` : `  ${megabytes(received)} MB`);
        }
        done(null, chunk);
      }
    });
    await pipeline(Readable.fromWeb(response.body), progress, createWriteStream(file));
  } finally { clearTimeout(timer); }
}
