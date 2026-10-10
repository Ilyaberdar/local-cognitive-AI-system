export function renderMarkdown(value: unknown): string;
export function renderCodeBlock(content: string, language?: string, label?: string): string;
export function renderCodeLines(content: string, filePath?: string): string[];
export function bindMarkdownActions(root: HTMLElement): void;
export function renderReleaseNotes(html: unknown): string;
