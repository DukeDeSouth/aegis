import { describe, expect, it } from 'vitest';
import {
  DockerSandboxRunner,
  buildRunArgs,
  type ExecFn,
  type ExecResult,
} from '../../src/sandbox/runner.ts';
import type { SandboxLimits } from '../../src/sandbox/types.ts';

const IMAGE = 'alpine:test@sha256:deadbeef';
const NET = 'aegis-internal';

function limits(overrides: Partial<SandboxLimits> = {}): SandboxLimits {
  return { timeoutMs: 5000, memoryBytes: 64 * 1024 * 1024, allowedHosts: [], ...overrides };
}

function args(l: SandboxLimits, entrypoint = 'main.sh'): string[] {
  return buildRunArgs({
    name: 'aegis-sb-x',
    skillDir: '/skills/demo',
    entrypoint,
    limits: l,
    image: IMAGE,
    internalNetwork: NET,
  });
}

describe('buildRunArgs — hardened-профиль ADR-0006', () => {
  it('содержит полный набор флагов изоляции', () => {
    const a = args(limits());
    const joined = a.join(' ');
    expect(joined).toContain('--cap-drop ALL');
    expect(joined).toContain('--security-opt no-new-privileges');
    expect(joined).toContain('--user 65534:65534');
    expect(joined).toContain('--read-only');
    expect(joined).toContain('--tmpfs /tmp:rw,noexec,nosuid,size=16m');
    expect(joined).toContain('--pids-limit 64');
    expect(joined).toContain('--cpus 1');
    expect(joined).toContain('--rm');
  });

  it('лимит памяти уходит в --memory и --memory-swap (своп запрещён)', () => {
    const a = args(limits({ memoryBytes: 128 }));
    expect(a[a.indexOf('--memory') + 1]).toBe('128');
    expect(a[a.indexOf('--memory-swap') + 1]).toBe('128');
  });

  it('пустой allowedHosts → --network none', () => {
    const a = args(limits({ allowedHosts: [] }));
    expect(a[a.indexOf('--network') + 1]).toBe('none');
  });

  it('непустой allowedHosts → internal-сеть (enforce хостов — на брокере)', () => {
    const a = args(limits({ allowedHosts: ['api.example.com'] }));
    expect(a[a.indexOf('--network') + 1]).toBe(NET);
    expect(a.join(' ')).not.toContain('api.example.com');
  });

  it('skillDir монтируется read-only, workdir /skill, шелл-запуск entrypoint', () => {
    const a = args(limits());
    expect(a[a.indexOf('-v') + 1]).toBe('/skills/demo:/skill:ro');
    expect(a[a.indexOf('--workdir') + 1]).toBe('/skill');
    expect(a.slice(-3)).toEqual([IMAGE, '/bin/sh', '/skill/main.sh']);
  });

  it('workspaceDir добавляет rw-mount /workspace', () => {
    const a = buildRunArgs({
      name: 't',
      skillDir: '/skills/demo',
      entrypoint: 'main.sh',
      limits: limits(),
      image: IMAGE,
      internalNetwork: NET,
      workspaceDir: '/data/workspace',
    });
    expect(a).toContain('/data/workspace:/workspace:rw');
  });

  it('path traversal в entrypoint отклоняется', () => {
    expect(() => args(limits(), '../host.sh')).toThrow(/relative path/);
    expect(() => args(limits(), 'a/../../b.sh')).toThrow(/relative path/);
    expect(() => args(limits(), '/etc/passwd')).toThrow(/relative path/);
  });

  it('передаёт -e env перед образом', () => {
    const a = buildRunArgs({
      name: 't',
      skillDir: '/skills/demo',
      entrypoint: 'main.sh',
      limits: limits(),
      image: IMAGE,
      internalNetwork: NET,
      env: { TARGET_HOST: 'example.com' },
    });
    const imageIdx = a.indexOf(IMAGE);
    expect(a[imageIdx - 2]).toBe('-e');
    expect(a[imageIdx - 1]).toBe('TARGET_HOST=example.com');
    expect(a.slice(-3)).toEqual([IMAGE, '/bin/sh', '/skill/main.sh']);
  });
});

describe('DockerSandboxRunner', () => {
  function capture(result: ExecResult): { exec: ExecFn; calls: string[][] } {
    const calls: string[][] = [];
    const exec: ExecFn = (argv) => {
      calls.push(argv);
      return Promise.resolve(result);
    };
    return { exec, calls };
  }

  it('run передаёт argv в exec и возвращает результат как данные (exit != 0 — не ошибка)', async () => {
    const { exec, calls } = capture({ exitCode: 3, stdout: 'out', stderr: 'err' });
    const runner = new DockerSandboxRunner({ image: IMAGE, internalNetwork: NET, exec });

    const r = await runner.run('/skills/demo', 'main.sh', limits());
    expect(r).toEqual({ exitCode: 3, stdout: 'out', stderr: 'err', timedOut: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe('run');
    expect(calls[0]?.join(' ')).toContain('--cap-drop ALL');
  });

  it('таймаут: по истечении timeoutMs зовёт docker kill и помечает timedOut', async () => {
    const calls: string[][] = [];
    let killResolve: (() => void) | undefined;
    const exec: ExecFn = (argv) => {
      calls.push(argv);
      if (argv[0] === 'kill') {
        killResolve?.();
        return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
      }
      // «повисший» контейнер: run завершается только после kill
      return new Promise((res) => {
        killResolve = () => res({ exitCode: 137, stdout: '', stderr: 'killed' });
      });
    };
    const runner = new DockerSandboxRunner({ image: IMAGE, internalNetwork: NET, exec });

    const r = await runner.run('/skills/demo', 'main.sh', limits({ timeoutMs: 20 }));
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBe(137);
    expect(calls.some((c) => c[0] === 'kill')).toBe(true);
  });

  it('уникальное имя контейнера с префиксом aegis-sb-', async () => {
    const { exec, calls } = capture({ exitCode: 0, stdout: '', stderr: '' });
    const runner = new DockerSandboxRunner({ image: IMAGE, internalNetwork: NET, exec });
    await runner.run('/skills/demo', 'main.sh', limits());
    await runner.run('/skills/demo', 'main.sh', limits());

    const names = calls.map((c) => c[c.indexOf('--name') + 1]);
    expect(names[0]).toMatch(/^aegis-sb-[0-9a-f]{12}$/);
    expect(names[0]).not.toBe(names[1]);
  });
});
