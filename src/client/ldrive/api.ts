import { z } from "zod";

// What LDrive's server answers, read with the same shapes apps/ldrive/page-shapes.test.ts checks
// against the real store. A change on one side fails there.

export const Folders = z.array(z.object({ id: z.string(), name: z.string(), files: z.number() }));
export type Folder = z.infer<typeof Folders>[number];

export const Files = z.array(
  z.object({
    id: z.string(),
    name: z.string(),
    contentType: z.string(),
    size: z.number(),
    uploadedBy: z.string(),
    createdAt: z.string(),
  }),
);
export type DriveFile = z.infer<typeof Files>[number];
