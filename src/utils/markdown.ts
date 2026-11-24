export function stripMarkdown(md: string): string {
  return md
    .replace(/\*\*([^*\r\n]+)\*\*/g, '$1')
    .replace(/\*([^*\r\n]+)\*/g, '$1')
    .replace(/#+\s*/g, '')
    .replace(/\[([^\][]+)\]\(([^()]+)\)/g, '$1')
    .replace(/^[-*]\s+/gm, '\u2022 ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
