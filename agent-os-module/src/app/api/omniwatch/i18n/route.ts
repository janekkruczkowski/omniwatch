import I18N from "@/lib/omniwatchI18n";
import { createI18nHandler } from "./handler.ts";

export const runtime = "nodejs";

// The same translations the prompts use, handed to the tab so the section headings it
// styles always match the headings the model was told to write.
export async function GET(): Promise<Response> {
  return createI18nHandler(I18N).GET();
}
