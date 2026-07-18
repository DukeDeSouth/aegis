import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { generateBrokerCerts, renderBrokerClientEnvoy } from '../src/certs.ts';

describe('certs', () => {
  it('generates CA, server, and client material', () => {
    const root = mkdtempSync(join(tmpdir(), 'aegis-certs-'));
    try {
      const paths = generateBrokerCerts(root, 'broker.test');
      expect(paths.serverCrt).toContain('server.crt');
      expect(paths.clientCrt).toContain('client.crt');
      const clientYaml = renderBrokerClientEnvoy('broker.test');
      expect(clientYaml).toContain('broker.test');
      expect(clientYaml).toContain('port_value: 8443');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
