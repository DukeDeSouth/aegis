/**
 * V3 (THREAT_MODEL): код в sandbox не выходит за границу — ни в сеть мимо
 * брокера, ни в файловую систему хоста. Каждый негативный тест имеет парный
 * позитивный контроль (IMPACT R1): команда падает из-за границы, а не потому,
 * что окружение сломано.
 */
import { writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DockerSandboxRunner } from '../../src/sandbox/runner.ts';
import type { SandboxLimits } from '../../src/sandbox/types.ts';
import { ALPINE, cleanupByPrefix, docker, dockerAvailable, mountableTmpDir } from './helpers.ts';

const hasDocker = await dockerAvailable();
const PREFIX = 'aegis-test-v3';
const NET = `${PREFIX}-int`;

const limits = (overrides: Partial<SandboxLimits> = {}): SandboxLimits => ({
  timeoutMs: 30_000,
  memoryBytes: 64 * 1024 * 1024,
  allowedHosts: [],
  ...overrides,
});

describe.skipIf(!hasDocker)('V3: побег из sandbox невозможен', () => {
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
    skillDir = mountableTmpDir('aegis-v3-skill-');
    hostDir = mountableTmpDir('aegis-v3-host-');
    writeFileSync(join(hostDir, 'host-secret.txt'), 'host marker');
    writeFileSync(join(skillDir, 'marker.txt'), 'skill marker');
    runner = new DockerSandboxRunner({ image: ALPINE, internalNetwork: NET });
  });

  afterAll(async () => {
    await cleanupByPrefix(PREFIX);
    rmSync(skillDir, { recursive: true, force: true });
    rmSync(hostDir, { recursive: true, force: true });
  });

  it('deny-all egress: с пустым allowedHosts сеть отрезана полностью', async () => {
    const r = await runner.run(
      skillDir,
      skill('egress.sh', 'wget -T 3 -qO- http://1.1.1.1 && echo REACHED'),
      limits(),
    );
    expect(r.exitCode).not.toBe(0);
    expect(r.stdout).not.toContain('REACHED');
  });

  it('non-root: процесс исполняется под uid 65534', async () => {
    const r = await runner.run(skillDir, skill('uid.sh', 'id -u'), limits());
    expect(r.exitCode).toBe(0); // позитивный контроль: команда исполнилась
    expect(r.stdout.trim()).toBe('65534');
  });

  it('read-only rootfs: запись вне /tmp падает, в /tmp — работает', async () => {
    const ro = await runner.run(skillDir, skill('ro.sh', 'touch /etc/x'), limits());
    expect(ro.exitCode).not.toBe(0);

    const rw = await runner.run(skillDir, skill('rw.sh', 'touch /tmp/x && echo TMP_OK'), limits());
    expect(rw.exitCode).toBe(0);
    expect(rw.stdout).toContain('TMP_OK');
  });

  it('noexec на /tmp: бинарный запуск блокирован, чтение — нет', async () => {
    const r = await runner.run(
      skillDir,
      skill(
        'noexec.sh',
        'cp /skill/noexec.sh /tmp/payload.sh && chmod +x /tmp/payload.sh && /tmp/payload.sh; echo EXEC_EXIT=$?',
      ),
      limits(),
    );
    expect(r.stdout).toContain('EXEC_EXIT=126'); // Permission denied — noexec
  });

  it('файлы хоста вне allowlist-mount не существуют для контейнера', async () => {
    const hostFile = join(hostDir, 'host-secret.txt');
    const r = await runner.run(
      skillDir,
      skill('hostfs.sh', `cat '${hostFile}'; echo CAT_EXIT=$?; cat /skill/marker.txt`),
      limits(),
    );
    expect(r.stdout).not.toContain('host marker'); // негатив: путь хоста пуст
    expect(r.stdout).toContain('CAT_EXIT=1');
    expect(r.stdout).toContain('skill marker'); // контроль: allowlist-mount читается
  });

  it('allowlist-mount строго read-only', async () => {
    const r = await runner.run(
      skillDir,
      skill('skillro.sh', 'touch /skill/write-attempt'),
      limits(),
    );
    expect(r.exitCode).not.toBe(0);
  });

  it('workspace mount rw: пишет в /workspace, не в /skill', async () => {
    const wsDir = mountableTmpDir('aegis-v3-ws-');
    const wsRunner = new DockerSandboxRunner({
      image: ALPINE,
      internalNetwork: NET,
      workspaceDir: wsDir,
    });
    const r = await wsRunner.run(
      skillDir,
      skill(
        'ws.sh',
        'echo WS_OK > /workspace/out.txt && cat /workspace/out.txt && touch /skill/x; echo SKILL_TOUCH=$?',
      ),
      limits(),
    );
    expect(r.stdout).toContain('WS_OK');
    expect(r.stdout).toContain('SKILL_TOUCH=1');
    expect(readFileSync(join(wsDir, 'out.txt'), 'utf8').trim()).toBe('WS_OK');
    rmSync(wsDir, { recursive: true, force: true });
  });

  it('таймаут: зависший код убивается, timedOut взводится', async () => {
    const r = await runner.run(skillDir, skill('hang.sh', 'sleep 60'), limits({ timeoutMs: 3000 }));
    expect(r.timedOut).toBe(true);

    const ok = await runner.run(skillDir, skill('fast.sh', 'echo FAST'), limits());
    expect(ok.timedOut).toBe(false); // позитивный контроль
    expect(ok.stdout).toContain('FAST');
  });
});
