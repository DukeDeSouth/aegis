import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveWorkspacePath, WorkspaceStore } from '../../src/host/workspace.ts';

describe('resolveWorkspacePath', () => {
  let root: string;

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('blocks traversal outside workspace', () => {
    root = mkdtempSync(join(tmpdir(), 'aegis-ws-'));
    expect(() => resolveWorkspacePath(root, '../../etc/passwd')).toThrow(/escapes|forbidden/);
  });

  it('blocks .aegis-trash direct access', () => {
    root = mkdtempSync(join(tmpdir(), 'aegis-ws-'));
    expect(() => resolveWorkspacePath(root, '.aegis-trash/x')).toThrow(/forbidden/);
  });

  it('blocks symlink escape when target exists', () => {
    root = mkdtempSync(join(tmpdir(), 'aegis-ws-'));
    const outside = mkdtempSync(join(tmpdir(), 'aegis-out-'));
    writeFileSync(join(outside, 'secret.txt'), 'x');
    symlinkSync(join(outside, 'secret.txt'), join(root, 'link.txt'));
    expect(() => resolveWorkspacePath(root, 'link.txt')).toThrow(/escapes/);
    rmSync(outside, { recursive: true, force: true });
  });
});

describe('WorkspaceStore', () => {
  let root: string;
  const NOW = 1_000_000;

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('write → modify → undo restores first version', () => {
    root = mkdtempSync(join(tmpdir(), 'aegis-ws-'));
    const ws = new WorkspaceStore(root, { now: () => NOW });
    ws.write('notes.md', 'v1');
    ws.write('notes.md', 'v2');
    expect(ws.read('notes.md')).toBe('v2');
    expect(ws.undo('notes.md')).toBe(true);
    expect(ws.read('notes.md')).toBe('v1');
  });

  it('delete moves file to trash', () => {
    root = mkdtempSync(join(tmpdir(), 'aegis-ws-'));
    const ws = new WorkspaceStore(root, { now: () => NOW });
    ws.write('draft.txt', 'hello');
    expect(ws.delete('draft.txt')).toBe(true);
    expect(() => ws.read('draft.txt')).toThrow();
    const trash = join(root, '.aegis-trash', String(NOW), 'draft.txt');
    expect(readFileSync(trash, 'utf8')).toBe('hello');
  });
});
