import { ChatAttachment } from "../types";

export const readAttachments = (metadata?: Record<string, unknown>): ChatAttachment[] => {
  const candidate = metadata?.attachments;

  if (!Array.isArray(candidate)) {
    return [];
  }

  return candidate.flatMap((item) => {
    if (!item || typeof item !== "object") {
      return [];
    }

    const record = item as Record<string, unknown>;
    const kind = record.kind;

    if (
      typeof record.id !== "string" ||
      typeof record.name !== "string" ||
      typeof record.mimeType !== "string" ||
      typeof record.sizeBytes !== "number" ||
      (kind !== "text" && kind !== "image" && kind !== "binary")
    ) {
      return [];
    }

    return [
      {
        id: record.id,
        name: record.name,
        mimeType: record.mimeType,
        sizeBytes: record.sizeBytes,
        kind,
        textContent: typeof record.textContent === "string" ? record.textContent : undefined,
        dataUrl: typeof record.dataUrl === "string" ? record.dataUrl : undefined
      } satisfies ChatAttachment
    ];
  });
};

export const renderAttachmentContext = (attachments: ChatAttachment[]): string => {
  if (attachments.length === 0) {
    return "";
  }

  return [
    "Attached files:",
    ...attachments.map((attachment) => {
      const base = `- ${attachment.name} (${attachment.mimeType}, ${Math.max(1, Math.round(attachment.sizeBytes / 1024))} KB, ${attachment.kind})`;

      if (attachment.kind === "text" && attachment.textContent?.trim()) {
        return [
          base,
          "  Extracted text:",
          ...attachment.textContent
            .trim()
            .slice(0, 6000)
            .split("\n")
            .map((line) => `  ${line}`)
        ].join("\n");
      }

      if (attachment.kind === "image") {
        return `${base}\n  Image attached. Use any visible filename/context cues; direct image understanding may depend on provider capabilities.`;
      }

      return `${base}\n  Binary attachment metadata only.`;
    })
  ].join("\n");
};
