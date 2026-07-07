/** Извлекает https-URL из markdown (источники web-digest в SKILL.md). */
export function parseHttpsUrlsFromMarkdown(md: string): string[] {
  const urls = new Set<string>();
  for (const m of md.matchAll(/https:\/\/[^\s)>\]"']+/g)) {
    urls.add(m[0]!);
  }
  return [...urls];
}
