/**
 * V2 (THREAT_MODEL): сырой секрет недостижим для агента/sandbox ни в одной
 * точке. Секрет живёт в файле, смонтированном только брокеру (Envoy
 * credential_injector); sandbox получает результат запроса, но не значение.
 *
 * Секрет — per-run случайный (IMPACT R3), никогда не из env разработчика.
 */
import { randomBytes } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DockerSandboxRunner } from '../../src/sandbox/runner.ts';
import type { SandboxLimits } from '../../src/sandbox/types.ts';
import {
  ALPINE,
  ENVOY,
  NODE,
  cleanupByPrefix,
  docker,
  dockerAvailable,
  mountableTmpDir,
  pollUntil,
} from './helpers.ts';

const hasDocker = await dockerAvailable();
const PREFIX = 'aegis-test-v2';
const NET_INT = `${PREFIX}-int`;
const NET_EG = `${PREFIX}-eg`;
const UPSTREAM = `${PREFIX}-upstream`;
const BROKER = `${PREFIX}-broker`;

const SECRET = `aegis-test-secret-${randomBytes(16).toString('hex')}`;

const limits = (): SandboxLimits => ({
  timeoutMs: 30_000,
  memoryBytes: 64 * 1024 * 1024,
  allowedHosts: ['upstream'],
});

/** Тестовый конфиг: та же структура фильтра, что в deploy/broker/envoy.yaml,
 *  но апстрим — plain http mock в egress-сети (TLS origination тут не нужен). */
function envoyTestConfig(): string {
  return `
node: { id: aegis-broker-test, cluster: aegis }
static_resources:
  listeners:
    - name: broker
      address: { socket_address: { address: 0.0.0.0, port_value: 8080 } }
      filter_chains:
        - filters:
            - name: envoy.filters.network.http_connection_manager
              typed_config:
                '@type': type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager
                stat_prefix: broker
                route_config:
                  name: allowlist
                  virtual_hosts:
                    - name: upstream
                      domains: ['upstream', 'upstream:*']
                      routes: [{ match: { prefix: '/' }, route: { cluster: upstream } }]
                http_filters:
                  - name: envoy.filters.http.credential_injector
                    typed_config:
                      '@type': type.googleapis.com/envoy.extensions.filters.http.credential_injector.v3.CredentialInjector
                      allow_request_without_credential: false
                      credential:
                        name: envoy.http.injected_credentials.generic
                        typed_config:
                          '@type': type.googleapis.com/envoy.extensions.http.injected_credentials.generic.v3.Generic
                          header_value_prefix: 'Bearer '
                          credential:
                            name: broker_token
                            sds_config: { path_config_source: { path: /etc/broker/secret.yaml } }
                  - name: envoy.filters.http.router
                    typed_config:
                      '@type': type.googleapis.com/envoy.extensions.filters.http.router.v3.Router
  clusters:
    - name: upstream
      type: STRICT_DNS
      load_assignment:
        cluster_name: upstream
        endpoints:
          - lb_endpoints:
              - endpoint:
                  address: { socket_address: { address: ${UPSTREAM}, port_value: 8080 } }
`;
}

const SDS_SECRET = `
resources:
  - '@type': type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.Secret
    name: broker_token
    generic_secret: { secret: { filename: /etc/broker/token.txt } }
`;

describe.skipIf(!hasDocker)('V2: секрет недостижим, инжекция только на брокере', () => {
  let brokerDir: string;
  let skillDir: string;
  let runner: DockerSandboxRunner;

  function skill(name: string, script: string): string {
    writeFileSync(join(skillDir, name), script);
    return name;
  }

  beforeAll(async () => {
    await cleanupByPrefix(PREFIX);
    await docker(['network', 'create', '--internal', NET_INT]);
    await docker(['network', 'create', NET_EG]);

    brokerDir = mountableTmpDir('aegis-v2-broker-');
    skillDir = mountableTmpDir('aegis-v2-skill-');
    writeFileSync(join(brokerDir, 'token.txt'), SECRET);
    writeFileSync(join(brokerDir, 'secret.yaml'), SDS_SECRET);
    writeFileSync(join(brokerDir, 'envoy.yaml'), envoyTestConfig());

    // Мок-апстрим живёт ТОЛЬКО в egress-сети: из internal он недостижим (t3).
    await docker([
      'run',
      '-d',
      '--name',
      UPSTREAM,
      '--network',
      NET_EG,
      NODE,
      'node',
      '-e',
      'require("http").createServer((q,s)=>{console.log(JSON.stringify(q.headers));s.end("ok")}).listen(8080)',
    ]);
    await docker([
      'run',
      '-d',
      '--name',
      BROKER,
      '--network',
      NET_INT,
      '-v',
      `${brokerDir}:/etc/broker:ro`,
      ENVOY,
      'envoy',
      '-c',
      '/etc/broker/envoy.yaml',
    ]);
    await docker(['network', 'connect', NET_EG, BROKER]);

    runner = new DockerSandboxRunner({ image: ALPINE, internalNetwork: NET_INT });

    // Готовность всего тракта sandbox→broker→upstream (активный поллинг, не sleep).
    await pollUntil(async () => {
      const r = await runner.run(
        skillDir,
        skill('ready.sh', `wget -T 3 -qO- --header 'Host: upstream' http://${BROKER}:8080/`),
        limits(),
      );
      return r.exitCode === 0 && r.stdout.includes('ok');
    });
  });

  afterAll(async () => {
    await cleanupByPrefix(PREFIX);
    rmSync(brokerDir, { recursive: true, force: true });
    rmSync(skillDir, { recursive: true, force: true });
  });

  it('инжекция работает: апстрим видит Bearer-секрет, sandbox — только ответ', async () => {
    const r = await runner.run(
      skillDir,
      skill('call.sh', `wget -qO- --header 'Host: upstream' http://${BROKER}:8080/`),
      limits(),
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('ok');
    expect(r.stdout).not.toContain(SECRET); // ответ не содержит секрета

    const logs = await docker(['logs', UPSTREAM]);
    expect(logs.stdout).toContain(`"authorization":"Bearer ${SECRET}"`);
  });

  it('секрет отсутствует в env и файловой системе sandbox', async () => {
    // Паттерн собирается конкатенацией двух половин: сам скрипт-охотник не
    // должен содержать секрет сплошной строкой, иначе grep находит его в /skill.
    const half = SECRET.length >> 1;
    const r = await runner.run(
      skillDir,
      skill(
        'hunt.sh',
        // /proc и /dev исключены осознанно: там блокирующие файлы; секрета в них
        // быть не может — env проверяется отдельной строкой.
        `S="${SECRET.slice(0, half)}""${SECRET.slice(half)}"
env; cat /proc/self/environ; grep -r "$S" /etc /tmp /skill /home /var /usr /bin /lib 2>/dev/null; echo HUNT_DONE`,
      ),
      limits(),
    );
    expect(r.stdout).toContain('HUNT_DONE'); // позитивный контроль: скрипт дошёл до конца
    expect(r.stdout).not.toContain(SECRET);
    expect(r.stderr).not.toContain(SECRET);
  });

  it('мимо брокера нельзя: апстрим из internal-сети недостижим напрямую', async () => {
    const r = await runner.run(
      skillDir,
      skill('bypass.sh', `wget -T 3 -qO- http://${UPSTREAM}:8080/ && echo BYPASSED`),
      limits(),
    );
    expect(r.exitCode).not.toBe(0);
    expect(r.stdout).not.toContain('BYPASSED');
  });

  it('не-allowlist Host отбрасывается брокером (404), запрос не уходит наружу', async () => {
    const before = (await docker(['logs', UPSTREAM])).stdout.split('\n').length;
    const r = await runner.run(
      skillDir,
      skill(
        'evil.sh',
        `wget -S -T 3 -qO- --header 'Host: evil.example' http://${BROKER}:8080/ 2>&1; echo WGET_EXIT=$?`,
      ),
      limits(),
    );
    expect(r.stdout).toContain('404');
    expect(r.stdout).toContain('WGET_EXIT=1');
    const after = (await docker(['logs', UPSTREAM])).stdout.split('\n').length;
    expect(after).toBe(before); // до апстрима ничего не дошло
  });

  it('прод-конфиг deploy/broker/envoy.yaml валиден (IMPACT R2)', async () => {
    const deployDir = fileURLToPath(new URL('../../deploy/broker', import.meta.url));
    const r = await docker([
      'run',
      '--rm',
      '-v',
      `${deployDir}/envoy.yaml:/etc/broker/envoy.yaml:ro`,
      '-v',
      `${deployDir}/secret.yaml:/etc/broker/secret.yaml:ro`,
      '-v',
      `${brokerDir}/token.txt:/etc/broker/token.txt:ro`,
      ENVOY,
      'envoy',
      '--mode',
      'validate',
      '-c',
      '/etc/broker/envoy.yaml',
    ]);
    expect(r.stdout + r.stderr).toContain("configuration '/etc/broker/envoy.yaml' OK");
    expect(r.exitCode).toBe(0);
  });
});
