import crypto from 'node:crypto';
import path from 'node:path';

export function nowIso() { return new Date().toISOString(); }
export function sha256Buffer(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }
export function sha256Text(text) { return sha256Buffer(Buffer.from(String(text || ''), 'utf8')); }
export function projectIdForRoot(root) { return `project_${sha256Text(path.resolve(root)).slice(0, 20)}`; }
export function posixPath(filePath) { return filePath.split(path.sep).join('/'); }
export function cleanName(name) { return String(name || 'project').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'project'; }
export function bytes(value) { return Number(value) || 0; }
export function bool(value, fallback = false) { return value == null ? fallback : Boolean(value); }
export function skillNameFromPath(filePath) { return path.basename(filePath).replace(/\.md$/i, ''); }
