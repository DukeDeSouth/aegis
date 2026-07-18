import { resolve } from 'node:path';
import { runConnector } from './connector.ts';
import { runInit, type InitOptions } from './init.ts';
import { runUpgrade } from './upgrade.ts';
import { runVerify } from './verify.ts';
import { backupUsage, runBackup, runRestore } from './backup.ts';

function usage(): void {
  console.log(`Usage: aegis-setup [command] [options]

Commands:
  init       Interactive install (default)
  verify     Smoke-check Node, Docker, config, broker, Telegram
  upgrade    Show diff and update deploy templates
  backup     Export data/workspace/skills to tar.gz
  restore    Restore from backup archive
  connector  list | add <name…> | upgrade <name…> — connector presets

Options:
  --dir <path>           Install directory (default: cwd)
  --force                Overwrite existing files
  --yes                  Non-interactive init (defaults + write)
  --broker-mode <mode>   local | remote (init)
  --broker-host <host>   Remote broker FQDN or IP (init, remote mode)
  -h, --help             Show help
`);
}

export async function main(argv: string[]): Promise<number> {
  const args = argv.slice(2);
  let cmd = 'init';
  let dir = process.cwd();
  let force = false;
  let yes = false;
  let brokerMode: InitOptions['brokerMode'];
  let brokerHost: string | undefined;
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '-h' || a === '--help') {
      usage();
      return 0;
    }
    if (a === '--dir') {
      dir = resolve(args[++i] ?? '.');
      continue;
    }
    if (a === '--force') {
      force = true;
      continue;
    }
    if (a === '--yes') {
      yes = true;
      continue;
    }
    if (a === '--broker-mode') {
      const mode = args[++i];
      if (mode !== 'local' && mode !== 'remote') {
        console.error('--broker-mode must be local or remote');
        return 1;
      }
      brokerMode = mode;
      continue;
    }
    if (a === '--broker-host') {
      brokerHost = args[++i];
      continue;
    }
    if (!a.startsWith('-')) {
      if (positional.length === 0) cmd = a;
      positional.push(a);
      continue;
    }
    console.error(`Unknown option: ${a}`);
    return 1;
  }

  switch (cmd) {
    case 'init':
    case 'setup':
      return runInit({
        targetDir: dir,
        force,
        nonInteractive: yes,
        ...(brokerMode !== undefined ? { brokerMode } : {}),
        ...(brokerHost !== undefined ? { brokerHost } : {}),
      });
    case 'verify':
      return runVerify({ root: dir });
    case 'upgrade':
      return runUpgrade({ root: dir, force });
    case 'backup':
      return runBackup({ root: dir, ...(positional[1] ? { out: positional[1] } : {}) });
    case 'restore': {
      const archive = positional[1];
      if (!archive) {
        backupUsage();
        return 1;
      }
      return runRestore({ root: dir, archive, force });
    }
    case 'connector':
      return runConnector(dir, positional.slice(1));
    default:
      console.error(`Unknown command: ${cmd}`);
      usage();
      return 1;
  }
}

main(process.argv).then((code) => {
  process.exitCode = code;
});
