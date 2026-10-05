import fs from 'fs';
import path from 'path';
import { Request, Response } from 'express';
import { pipeline } from 'stream';

export function containedPath(root: string, relative: string): string | null {
  const base = path.resolve(root);
  const target = path.resolve(base, relative);
  const rel = path.relative(base, target);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
  // A symlink must not make an otherwise valid relative path escape.
  if (fs.existsSync(target)) {
    const realRel = path.relative(fs.realpathSync(base), fs.realpathSync(target));
    if (realRel === '..' || realRel.startsWith(`..${path.sep}`) || path.isAbsolute(realRel)) return null;
  }
  return target;
}

export function parseRange(value: string, size: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2]) || size <= 0) return null;
  let start: number;
  let end: number;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) return null;
    end = Math.min(end, size - 1);
  }
  return { start, end };
}

export function streamFile(req: Request, res: Response, file: string, contentType: string): void {
  const stat = fs.statSync(file);
  if (!stat.isFile()) {
    res.status(404).json({ success: false, error: 'File missing on disk' });
    return;
  }
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(path.basename(file))}`);
  let range: { start: number; end: number } | undefined;
  if (req.headers.range) {
    const parsed = parseRange(req.headers.range, stat.size);
    if (!parsed) {
      res.setHeader('Content-Range', `bytes */${stat.size}`);
      res.status(416).end();
      return;
    }
    range = parsed;
    res.status(206);
    res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${stat.size}`);
  }
  res.setHeader('Content-Length', range ? range.end - range.start + 1 : stat.size);
  if (req.method === 'HEAD') { res.end(); return; }
  const input = fs.createReadStream(file, range);
  res.on('close', () => input.destroy());
  pipeline(input, res, (error) => {
    if (error && !res.destroyed) res.destroy(error);
  });
}
