import { z } from "zod";
import { HttpError } from "../../../apps/shared/server";
import { pdfText } from "../pdf-text";
import { readTool } from "./define";
import { Text } from "./shapes";

// The shared drive: LDrive, or Google Drive when the deploy reads it.

export const driveTools = {
  "drive.changes": readTool("List the files added to the shared drive after a page token.", z.object({ pageToken: z.string().regex(/^\d+$/) }), (ctx, args) =>
    ctx.deps.files.changes(args.pageToken),
  ),
  "drive.file_text": readTool("Read the text of a PDF in the shared drive.", z.object({ fileId: Text }), async (ctx, args) => {
    const { file, bytes } = await ctx.deps.files.content(args.fileId);
    if (!file.contentType.includes("pdf")) throw new HttpError(422, "Only a PDF file can be read as text.");
    return { file, ...(await pdfText(bytes)) };
  }),
};
