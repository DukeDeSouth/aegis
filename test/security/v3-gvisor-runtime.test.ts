/**
 * V3 subset под gVisor runsc (Sprint 40): hardened-профиль + user-space kernel.
 * Skip без Docker или без зарегистрированного runsc (типично macOS dev).
 */
import { writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DockerSandboxRunner } from '../../src/sandbox/runner.ts';
import type { SandboxLimits } from '../../src/sandbox/types.ts';
import { ALPINE, cleanupByPrefix, docker, dockerAvailable, mountableTmpDir } from './helpers.ts';

const hasDocker = await dockerAvailable();

async function gvisorAvailable(): Promise<boolean> {
  if (!hasDocker) return false;
  try {
    const info = await docker(['info', '--format', '{{json .Runtimes}}']);
    if (info.exitCode !== 0) return false;
    const runtimes = JSON.parse(info.stdout) as Record<string, unknown>;
    if (!('runsc' in runtimes)) return false;
    const smoke = await docker(['run', '--rm', '--runtime', 'runsc', ALPINE, 'true']);
    return smoke.exitCode === 0;
  } catch {
    return false;
  }
}

const hasGvisor = await gvisorAvailable();
const PREFIX = 'aegis-test-v3-gv';
const NET = `${PREFIX}-int`;

const limits = (overrides: Partial<SandboxLimits> = {}): SandboxLimits => ({
  timeoutMs: 30_000,
  memoryBytes: 64 * 1024 * 1024,
  allowedHosts: [],
  ...overrides,
});

describe.skipIf(!hasGvisor)('V3 gVisor: hardened-профиль под runsc', () => {
  let skillDir: string;
  let hostDir: string;
  let runner: DockerSandboxRunner;

  function skill(name: string, script: string): string {
    writeFileSync(join(skillDir, name), script);
    return name;
  }

  beforeAll(async () => {
    await cleanupByPrefix(PREFIX);
    await docker(['network', 'create', '--internal', NET]);
    skillDir = mountableTmpDir('aegis-v3gv-skill-');
    hostDir = mountableTmpDir('aegis-v3gv-host-');
    writeFileSync(join(hostDir, 'host-secret.txt'), 'host marker');
    writeFileSync(join(skillDir, 'marker.txt'), 'skill marker');
    runner = new DockerSandboxRunner({
      image: ALPINE,
      internalNetwork: NET,
      runtime: 'gvisor',
    });
  });

  afterAll(async () => {
    await cleanupByPrefix(PREFIX);
    rmSync(skillDir, { recursive: true, force: true });
    rmSync(hostDir, { recursive: true, force: true });
  });

  it('argv содержит --runtime runsc', async () => {
    const calls: string[][] = [];
    const gvRunner = new DockerSandboxRunner({
      image: ALPINE,
      internalNetwork: NET,
      runtime: 'gvisor',
      exec: (argv) => {
        calls.push(argv);
        return Promise.resolve({ exitCode: 0, stdout: '65534\n', stderr: '' });
      },
    });
    await gvRunner.run(skillDir, skill('uid.sh', 'id -u'), limits());
    expect(calls[0]?.slice(0, 4)).toEqual(['run', '--runtime', 'runsc', '--rm']);
  });

  it('deny-all egress: с пустым allowedHosts сеть отрезана', async () => {
    const r = await runner.run(
      skillDir,
      skill('egress.sh', 'wget -T 3 -qO- http://1.1.1.1 && echo REACHED'),
      limits(),
    );
    expect(r.exitCode).not.toBe(0);
    expect(r.stdout).not.toContain('REACHED');
  });

  it('non-root: uid 65534', async () => {
    const r = await runner.run(skillDir, skill('uid2.sh', 'id -u'), limits());
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('65534');
  });

  it('read-only rootfs + tmpfs noexec', async () => {
    const ro = await runner.run(skillDir, skill('ro.sh', 'touch /etc/x'), limits());
    expect(ro.exitCode).not.toBe(0);

    const rw = await runner.run(skillDir, skill('rw.sh', 'touch /tmp/x && echo TMP_OK'), limits());
    expect(rw.exitCode).toBe(0);
    expect(rw.stdout).toContain('TMP_OK');
  });

  it('файлы хоста вне allowlist-mount недоступны', async () => {
    const hostFile = join(hostDir, 'host-secret.txt');
    const r = await runner.run(
      skillDir,
      skill('hostfs.sh', `cat '${hostFile}'; echo CAT_EXIT=$?; cat /skill/marker.txt`),
      limits(),
    );
    expect(r.stdout).not.toContain('host marker');
    expect(r.stdout).toContain('CAT_EXIT=1');
    expect(r.stdout).toContain('skill marker');
  });

  it('workspace mount rw под runsc', async () => {
    const wsDir = mountableTmpDir('aegis-v3gv-ws-');
    const wsRunner = new DockerSandboxRunner({
      image: ALPINE,
      internalNetwork: NET,
      workspaceDir: wsDir,
      runtime: 'gvisor',
    });
    const r = await wsRunner.run(
      skillDir,
      skill('ws.sh', 'echo WS_OK > /workspace/out.txt && cat /workspace/out.txt'),
      limits(),
    );
    expect(r.stdout).toContain('WS_OK');
    expect(readFileSync(join(wsDir, 'out.txt'), 'utf8').trim()).toBe('WS_OK');
    rmSync(wsDir, { recursive: true, force: true });
  });
});
