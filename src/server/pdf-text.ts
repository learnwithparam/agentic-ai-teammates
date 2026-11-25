import { extractText, getDocumentProxy } from "unpdf";

// The text layer of a PDF. A scanned PDF with no text layer gives an empty string, and the
// teammate hands that invoice to a person rather than guess at it.

const MAX_PDF_BYTES = 10 * 1024 * 1024;
const MAX_TEXT = 40_000;

export async function pdfText(bytes: Uint8Array): Promise<{ pages: number; text: string }> {
  if (bytes.byteLength > MAX_PDF_BYTES) throw new Error("The PDF is larger than 10 MB.");
  const document = await getDocumentProxy(new Uint8Array(bytes));
  const { totalPages, text } = await extractText(document, { mergePages: true });
  return { pages: totalPages, text: text.replace(/[ \t]+\n/g, "\n").trim().slice(0, MAX_TEXT) };
}
