/**
 * Sprint 23 / C6: fetch.sh — HTML-очистка и RSS/Atom-выжимка (wget застаблен через PATH).
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const SCRIPT = join(process.cwd(), 'skills', 'web-fetch', 'fetch.sh');
const tmp = mkdtempSync(join(tmpdir(), 'aegis-fetch-sh-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function runScript(body: string): string {
  const bodyFile = join(tmp, `body-${Math.random().toString(36).slice(2)}`);
  writeFileSync(bodyFile, body, 'utf8');
  const wgetStub = join(tmp, 'wget');
  writeFileSync(
    wgetStub,
    `#!/bin/sh\nwhile [ "$1" != "-qO" ]; do shift; done\ncat "${bodyFile}" > "$2"\n`,
  );
  chmodSync(wgetStub, 0o755);
  return execFileSync('sh', [SCRIPT], {
    env: {
      PATH: `${tmp}:${process.env.PATH ?? ''}`,
      TARGET_HOST: 'example.com',
      BROKER_HOST: 'broker:8080',
    },
    encoding: 'utf8',
  });
}

describe('fetch.sh (C6)', () => {
  it('HTML: теги и скрипты вырезаны', () => {
    const out = runScript('<html><script>evil()</script><p>Hello <b>world</b></p></html>');
    expect(out).toContain('Hello world');
    expect(out).not.toContain('evil');
    expect(out).not.toContain('<p>');
  });

  it('RSS: заголовки и ссылки, по строке на item', () => {
    const out = runScript(
      '<?xml version="1.0"?><rss version="2.0"><channel><title>Feed</title>' +
        '<item><title>First post</title><link>https://ex.com/1</link></item>' +
        '<item><title><![CDATA[Second]]></title><link>https://ex.com/2</link></item>' +
        '</channel></rss>',
    );
    expect(out).toContain('First post — https://ex.com/1');
    expect(out).toContain('Second — https://ex.com/2');
    expect(out).not.toContain('<item>');
  });

  it('Atom: entry с link href', () => {
    const out = runScript(
      '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>F</title>' +
        '<entry><title>Atom one</title><link href="https://ex.com/a1"/></entry></feed>',
    );
    expect(out).toContain('Atom one — https://ex.com/a1');
  });
});
