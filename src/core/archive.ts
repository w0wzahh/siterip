import fs from 'fs';
import path from 'path';
import { Writable } from 'stream';
import archiver from 'archiver';
import type { FileNode } from '../types.js';

/** Zip a directory's contents into outPath. Returns zip size in bytes. */
export function zipDirectory(dir: string, outPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(outPath);
    const arc = archiver('zip', { zlib: { level: 6 } });
    out.on('close', () => resolve(arc.pointer()));
    arc.on('error', reject);
    arc.pipe(out);
    arc.directory(dir, false);
    arc.finalize();
  });
}

/** Zip just a sub-directory and stream it to an HTTP response. */
export function streamZip(dir: string, res: Writable): void {
  const arc = archiver('zip', { zlib: { level: 6 } });
  arc.on('error', () => res.destroy());
  arc.pipe(res);
  arc.directory(dir, false);
  void arc.finalize();
}

/** Build a JSON file-tree for the UI (folders first, then alphabetical). */
export function buildTree(rootDir: string, dir: string): FileNode {
  const name = path.basename(dir) || 'site';
  const children: FileNode[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    const rel = path.relative(rootDir, full).replace(/\\/g, '/');
    if (e.isDirectory()) {
      children.push({
        type: 'dir',
        name: e.name,
        path: rel,
        children: buildTree(rootDir, full).children,
      });
    } else {
      children.push({
        type: 'file',
        name: e.name,
        path: rel,
        size: fs.statSync(full).size,
        ext: path.extname(e.name).toLowerCase().slice(1),
      });
    }
  }
  return {
    type: 'dir',
    name,
    path: path.relative(rootDir, dir).replace(/\\/g, '/') || '.',
    children,
  };
}
