import { LanguagePreference, ProviderTarget } from "../types";
import { LLMService } from "./LLMService";

interface TranslationPayload {
  items?: string[];
}

const CYRILLIC_RE = /[А-Яа-яЁёІіЇїЄєҐґ]/g;
const LATIN_RE = /[A-Za-z]/g;

const countMatches = (value: string, pattern: RegExp): number => value.match(pattern)?.length ?? 0;

export class LanguageEnforcer {
  constructor(private readonly llmService: LLMService) {}

  async normalizeText(
    text: string,
    language: LanguagePreference,
    target: ProviderTarget
  ): Promise<string> {
    const [item] = await this.normalizeMany([text], language, target);
    return item;
  }

  async normalizeMany(
    items: string[],
    language: LanguagePreference,
    target: ProviderTarget
  ): Promise<string[]> {
    if (language === "auto" || items.length === 0 || !target.providerId || target.providerId === "local") {
      return items;
    }

    const indexed = items.map((value, index) => ({ value, index }));
    const toTranslate = indexed.filter(({ value }) => this.shouldTranslate(value, language));

    if (toTranslate.length === 0) {
      return items;
    }

    const { data } = await this.llmService.generateObject<TranslationPayload>(
      {
        systemPrompt: `You are a precise translator. Translate each item into ${this.languageName(
          language
        )}. Output valid JSON only.`,
        model: target.model,
        prompt: [
          `Translate every item into ${this.languageName(language)}.`,
          "Preserve ordering, meaning, and bullet/list style.",
          "Do not add commentary or explanations.",
          "Keep model ids, API names, and product names unchanged where appropriate.",
          "",
          `Items: ${JSON.stringify(toTranslate.map(({ value }) => value))}`,
          "",
          'Return JSON with key "items" as an array of translated strings.'
        ].join("\n")
      },
      target.providerId
    );

    if (!data?.items || data.items.length !== toTranslate.length) {
      return items;
    }

    const next = [...items];

    toTranslate.forEach(({ index }, translatedIndex) => {
      const translated = data.items?.[translatedIndex]?.trim();

      if (translated) {
        next[index] = translated;
      }
    });

    return next;
  }

  shouldTranslate(text: string, language: LanguagePreference): boolean {
    if (language === "auto") {
      return false;
    }

    const trimmed = text.trim();

    if (!trimmed) {
      return false;
    }

    const cyrillic = countMatches(trimmed, CYRILLIC_RE);
    const latin = countMatches(trimmed, LATIN_RE);

    if (language === "ru") {
      return latin > 12 && latin > cyrillic * 1.5;
    }

    return cyrillic > 6 && cyrillic > latin;
  }

  private languageName(language: Exclude<LanguagePreference, "auto">): string {
    return language === "ru" ? "Russian" : "English";
  }
}
