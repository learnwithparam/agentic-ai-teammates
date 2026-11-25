import { extractText, getDocumentProxy } from "unpdf";
import { HttpError } from "../../apps/shared/server";

// The text layer of a PDF. A scanned PDF with no text layer gives an empty string, and the
// teammate hands that invoice to a person rather than guess at it. So does a damaged PDF: it is
// refused with 422, which tells the caller that trying again will not help.

const MAX_PDF_BYTES = 10 * 1024 * 1024;
const MAX_TEXT = 40_000;

export async function pdfText(bytes: Uint8Array): Promise<{ pages: number; text: string }> {
  if (bytes.byteLength > MAX_PDF_BYTES) throw new HttpError(422, "The PDF is larger than 10 MB.");
  const document = await getDocumentProxy(new Uint8Array(bytes)).catch(() => {
    throw new HttpError(422, "The PDF is damaged and cannot be opened.");
  });
  const { totalPages, text } = await extractText(document, { mergePages: true });
  return { pages: totalPages, text: text.replace(/[ \t]+\n/g, "\n").trim().slice(0, MAX_TEXT) };
}
