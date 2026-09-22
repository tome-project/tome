import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';

/**
 * iOS will not start an m4a/m4b until it has read the moov atom. If that
 * atom sits after a gigabyte of audio, the player has to pull the tail of
 * the file before the first second of sound, and a walk on a phone gives
 * up. `ffmpeg -movflags +faststart` moves moov to the front without
 * re-encoding. Files that are already fast return immediately.
 */
export async function ensureAudiobookFastStart(filePath: string): Promise<void> {
  const ext = path.extname(filePath).toLowerCase();
  if (ext !== '.m4a' && ext !== '.m4b') return;
  if (await moovPrecedesMdat(filePath)) return;

  const tmp = `${filePath}.faststart${ext}`;
  try {
    await runFfmpeg([
      '-y',
      '-i',
      filePath,
      '-c',
      'copy',
      '-movflags',
      '+faststart',
      tmp,
    ]);
    await fs.rename(tmp, filePath);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    const message = err instanceof Error ? err.message : 'ffmpeg failed';
    console.warn(`[scan] left ${path.basename(filePath)} unchanged: ${message}`);
  }
}

async function moovPrecedesMdat(filePath: string): Promise<boolean> {
  const fh = await fs.open(filePath, 'r');
  try {
    let pos = 0;
    const buf = Buffer.alloc(16);
    for (let i = 0; i < 8; i++) {
      const head = await fh.read(buf, 0, 8, pos);
      if (head.bytesRead < 8) return false;
      let size = buf.readUInt32BE(0);
      const name = buf.toString('latin1', 4, 8);
      let header = 8;
      if (size === 1) {
        const ext = await fh.read(buf, 0, 8, pos + 8);
        if (ext.bytesRead < 8) return false;
        size = Number(buf.readBigUInt64BE(0));
        header = 16;
      }
      if (size < header) return false;
      if (name === 'moov') return true;
      if (name === 'mdat') return false;
      pos += size;
      if (pos > 8 * 1024 * 1024) return false;
    }
    return false;
  } finally {
    await fh.close();
  }
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, { stdio: 'ignore' });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}`));
    });
  });
}
