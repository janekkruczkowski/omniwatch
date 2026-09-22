import { NextResponse } from "next/server";
import I18N from "@/lib/omniwatchI18n";

export const runtime = "nodejs";

// The same translations the prompts use, handed to the tab so the section headings
// it styles always match the headings the model was told to write.
export async function GET() {
  return NextResponse.json(I18N);
}
