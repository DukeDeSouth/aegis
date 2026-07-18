/**
 * V2 extension (Sprint 39 S1): remote broker — секреты только на broker-хосте;
 * core использует broker-client forwarder без secret mounts.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateBrokerCerts, renderBrokerClientEnvoy } from '../../packages/aegis-setup/src/certs.ts';
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
const PREFIX = 'aegis-test-v2r';
const NET_INT = `${PREFIX}-int`;
const NET_EG = `${PREFIX}-eg`;
const NET_LINK = `${PREFIX}-link`;
const UPSTREAM = `${PREFIX}-upstream`;
const REMOTE_BROKER = `${PREFIX}-remote-broker`;
const BROKER_CLIENT = 'aegis-broker-client';

const SECRET = `aegis-remote-secret-${randomBytes(16).toString('hex')}`;

const limits = (): SandboxLimits => ({
  timeoutMs: 30_000,
  memoryBytes: 64 * 1024 * 1024,
  allowedHosts: [BROKER_CLIENT],
});

const SDS_SECRET = `
resources:
  - '@type': type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.Secret
    name: broker_token
    generic_secret: { secret: { filename: /etc/broker/token.txt } }
`;

function remoteBrokerEnvoy(upstreamHost: string): string {
  return `
node: { id: aegis-broker-remote-test, cluster: aegis }
static_resources:
  listeners:
    - name: broker_mtls
      address: { socket_address: { address: 0.0.0.0, port_value: 8443 } }
      filter_chains:
        - transport_socket:
            name: envoy.transport_sockets.tls
            typed_config:
              '@type': type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.DownstreamTlsContext
              require_client_certificate: true
              common_tls_context:
                tls_certificates:
                  - certificate_chain: { filename: /etc/broker/tls/server.crt }
                    private_key: { filename: /etc/broker/tls/server.key }
                validation_context:
                  trusted_ca: { filename: /etc/broker/tls/ca.crt }
          filters:
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
                  address: { socket_address: { address: ${upstreamHost}, port_value: 8080 } }
`;
}

describe.skipIf(!hasDocker)('V2 remote: секреты только на broker-хосте', () => {
  let rootDir: string;
  let brokerDir: string;
  let clientDir: string;
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
    await docker(['network', 'create', NET_LINK]);

    rootDir = mountableTmpDir('aegis-v2r-root-');
    brokerDir = join(rootDir, 'deploy', 'broker-remote');
    clientDir = join(rootDir, 'deploy', 'broker-client');
    skillDir = mountableTmpDir('aegis-v2r-skill-');

    generateBrokerCerts(rootDir, REMOTE_BROKER);
    mkdirSync(join(brokerDir, 'secrets'), { recursive: true });
    writeFileSync(join(brokerDir, 'secrets', 'token.txt'), SECRET);
    writeFileSync(join(brokerDir, 'secret.yaml'), SDS_SECRET);
    writeFileSync(join(brokerDir, 'envoy.yaml'), remoteBrokerEnvoy(UPSTREAM));
    writeFileSync(join(clientDir, 'envoy.yaml'), renderBrokerClientEnvoy(REMOTE_BROKER));

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
      REMOTE_BROKER,
      '--network',
      NET_LINK,
      '-v',
      `${brokerDir}/envoy.yaml:/etc/broker/envoy.yaml:ro`,
      '-v',
      `${brokerDir}/secret.yaml:/etc/broker/secret.yaml:ro`,
      '-v',
      `${brokerDir}/secrets/token.txt:/etc/broker/token.txt:ro`,
      '-v',
      `${join(brokerDir, 'certs', 'server')}:/etc/broker/tls:ro`,
      ENVOY,
      'envoy',
      '-c',
      '/etc/broker/envoy.yaml',
    ]);
    await docker(['network', 'connect', NET_EG, REMOTE_BROKER]);

    await docker([
      'run',
      '-d',
      '--name',
      BROKER_CLIENT,
      '--network',
      NET_INT,
      '-v',
      `${clientDir}/envoy.yaml:/etc/broker-client/envoy.yaml:ro`,
      '-v',
      `${join(clientDir, 'certs', 'client')}:/etc/broker-client/tls:ro`,
      ENVOY,
      'envoy',
      '-c',
      '/etc/broker-client/envoy.yaml',
    ]);
    await docker(['network', 'connect', NET_LINK, BROKER_CLIENT]);

    runner = new DockerSandboxRunner({ image: ALPINE, internalNetwork: NET_INT });

    await pollUntil(async () => {
      const r = await runner.run(
        skillDir,
        skill(
          'ready.sh',
          `wget -T 3 -qO- --header 'Host: upstream' http://${BROKER_CLIENT}:8080/`,
        ),
        limits(),
      );
      return r.exitCode === 0 && r.stdout.includes('ok');
    });
  }, 120_000);

  afterAll(async () => {
    await cleanupByPrefix(PREFIX);
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(skillDir, { recursive: true, force: true });
  });

  it('инжекция через broker-client → remote mTLS broker', async () => {
    const r = await runner.run(
      skillDir,
      skill('call.sh', `wget -qO- --header 'Host: upstream' http://${BROKER_CLIENT}:8080/`),
      limits(),
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('ok');
    expect(r.stdout).not.toContain(SECRET);

    const logs = await docker(['logs', UPSTREAM]);
    expect(logs.stdout).toContain(`"authorization":"Bearer ${SECRET}"`);
  });

  it('core-сеть не содержит secret-файл broker-хоста', async () => {
    const r = await docker([
      'run',
      '--rm',
      '--network',
      NET_INT,
      ALPINE,
      'sh',
      '-c',
      'cat /etc/broker/token.txt 2>/dev/null; echo CORE_DONE',
    ]);
    expect(r.stdout).toContain('CORE_DONE');
    expect(r.stdout).not.toContain(SECRET);
  });

  it('broker-client контейнер не монтирует token.txt', async () => {
    const r = await docker([
      'exec',
      BROKER_CLIENT,
      'sh',
      '-c',
      'cat /etc/broker/token.txt 2>/dev/null; echo CLIENT_DONE',
    ]);
    expect(r.stdout).toContain('CLIENT_DONE');
    expect(r.stdout).not.toContain(SECRET);
  });
});
