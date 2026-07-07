import { createInterface } from 'node:readline';

export function createPrompter(input = process.stdin, output = process.stdout) {
  const rl = createInterface({ input, output });

  const ask = (question: string, defaultValue?: string): Promise<string> =>
    new Promise((resolve) => {
      const hint = defaultValue !== undefined ? ` [${defaultValue}]` : '';
      rl.question(`${question}${hint}: `, (answer) => {
        const v = answer.trim();
        resolve(v.length > 0 ? v : (defaultValue ?? ''));
      });
    });

  const confirm = async (question: string, defaultYes = false): Promise<boolean> => {
    const hint = defaultYes ? 'Y/n' : 'y/N';
    const a = (await ask(`${question} (${hint})`)).toLowerCase();
    if (a.length === 0) return defaultYes;
    return a === 'y' || a === 'yes';
  };

  const close = (): void => {
    rl.close();
  };

  return { ask, confirm, close };
}
