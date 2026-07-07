import { resolve } from 'node:path';
import { runInit } from './init.ts';
import { runUpgrade } from './upgrade.ts';
import { runVerify } from './verify.ts';

function usage(): void {
  console.log(`Usage: aegis-setup [command] [options]

Commands:
  init      Interactive install (default)
  verify    Smoke-check Node, Docker, config, broker, Telegram
  upgrade   Show diff and update deploy templates

Options:
  --dir <path>   Install directory (default: cwd)
  --force        Overwrite existing files
  --yes          Non-interactive init (defaults + write)
  -h, --help     Show help
`);
}

export async function main(argv: string[]): Promise<number> {
  const args = argv.slice(2);
  let cmd = 'init';
  let dir = process.cwd();
  let force = false;
  let yes = false;

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
    if (!a.startsWith('-')) {
      cmd = a;
      continue;
    }
    console.error(`Unknown option: ${a}`);
    return 1;
  }

  switch (cmd) {
    case 'init':
    case 'setup':
      return runInit({ targetDir: dir, force, nonInteractive: yes });
    case 'verify':
      return runVerify({ root: dir });
    case 'upgrade':
      return runUpgrade({ root: dir, force });
    default:
      console.error(`Unknown command: ${cmd}`);
      usage();
      return 1;
  }
}

main(process.argv).then((code) => {
  process.exitCode = code;
});
