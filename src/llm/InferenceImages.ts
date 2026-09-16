import { AsyncLocalStorage } from "async_hooks";
import { LLMImage } from "../types";

// Scope images to one engine run, including its parallel agents. Never keep them
// on the shared provider instance, where concurrent conversations could mix.
const images = new AsyncLocalStorage<LLMImage[]>();
export const withInferenceImages = <T>(value: LLMImage[], action: () => T): T => images.run(value, action);
export const currentInferenceImages = (): LLMImage[] | undefined => images.getStore();

export function decodeImage(image: LLMImage): { mimeType: "image/png" | "image/jpeg" | "image/webp"; data: string } {
  if (!image || typeof image.dataUrl !== "string") throw new Error("Image data is missing. Reattach a valid PNG, JPEG or WebP image.");
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(image.dataUrl);
  if (!match || match[2].length > Math.ceil(1024 * 1024 / 3) * 4) throw new Error("Images must be PNG, JPEG or WebP, no larger than 1 MB after resizing. Reattach the image.");
  const bytes = Buffer.from(match[2], "base64");
  const valid = match[1] === "image/png" ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
    : match[1] === "image/jpeg" ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
    : bytes.subarray(0,4).toString() === "RIFF" && bytes.subarray(8,12).toString() === "WEBP";
  if (!valid || bytes.length > 1024 * 1024 || bytes.toString("base64") !== match[2]) throw new Error("The image data does not match its file type. Reattach a valid PNG, JPEG or WebP image.");
  return { mimeType: match[1] as "image/png" | "image/jpeg" | "image/webp", data: match[2] };
}

export function validateImages(value: LLMImage[] | undefined): LLMImage[] {
  if (!value) return [];
  if (!Array.isArray(value) || value.length > 5) throw new Error("A model request supports up to five images.");
  for (const image of value) decodeImage(image);
  return value;
}
