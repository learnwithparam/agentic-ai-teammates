import { Download, FileText, Folder as FolderIcon, Trash2, Upload } from "lucide-react";
import { type ChangeEvent, useRef, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { problemText } from "@/lib/http";
import { dateTime, fileSize, http, isAdmin, type Person, TopBar, useAnswer } from "@/lib/page";
import { type DriveFile, Files, Folders } from "./api";

// A shared drive: folders on the left, the chosen folder's files on the right. A file put in
// Invoices is what the invoice teammate is told about. Only the uploader or an admin removes a file.

function FileRow({ file, person, onRemoved, onProblem }: { file: DriveFile; person: Person; onRemoved: () => void; onProblem: (text: string) => void }) {
  const [removing, setRemoving] = useState(false);
  const mayRemove = file.uploadedBy === person.email || isAdmin(person);

  async function remove() {
    setRemoving(true);
    try {
      await http.post(`/api/files/${encodeURIComponent(file.id)}`, undefined, "DELETE");
      onRemoved();
    } catch (error) {
      onProblem(problemText(error, `${file.name} was not removed. Try again.`));
      setRemoving(false);
    }
  }

  return (
    <TableRow>
      <TableCell className="max-w-0 w-full">
        <a href={`/api/files/${encodeURIComponent(file.id)}/content`} className="flex min-w-0 items-center gap-2 hover:underline">
          <FileText className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate">{file.name}</span>
        </a>
      </TableCell>
      <TableCell className="hidden text-muted-foreground md:table-cell">{file.uploadedBy}</TableCell>
      <TableCell className="hidden whitespace-nowrap text-muted-foreground sm:table-cell">{dateTime.format(new Date(file.createdAt))}</TableCell>
      <TableCell className="text-right whitespace-nowrap tabular-nums text-muted-foreground">{fileSize(file.size)}</TableCell>
      <TableCell className="w-px whitespace-nowrap">
        <div className="flex justify-end gap-1">
          <Button asChild variant="ghost" size="icon" aria-label={`Download ${file.name}`}>
            <a href={`/api/files/${encodeURIComponent(file.id)}/content`}>
              <Download />
            </a>
          </Button>
          {mayRemove && (
            <Button variant="ghost" size="icon" aria-label={`Remove ${file.name}`} disabled={removing} onClick={remove}>
              <Trash2 />
            </Button>
          )}
        </div>
      </TableCell>
    </TableRow>
  );
}

export function Drive({ person }: { person: Person }) {
  const folders = useAnswer("/api/folders", Folders);
  const [chosen, setChosen] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const folder = folders.data?.find((item) => item.id === chosen) ?? folders.data?.[0] ?? null;
  const files = useAnswer(folder ? `/api/folders/${encodeURIComponent(folder.id)}/files` : null, Files);

  function changed() {
    files.reload();
    folders.reload();
  }

  async function upload(event: ChangeEvent<HTMLInputElement>) {
    if (!folder) return;
    const picked = [...(event.target.files ?? [])];
    event.target.value = "";
    setUploading(true);
    setProblem(null);
    try {
      for (const file of picked) await http.upload(`/api/folders/${encodeURIComponent(folder.id)}/files?name=${encodeURIComponent(file.name)}`, file);
    } catch (error) {
      setProblem(problemText(error, "The upload stopped. Try again."));
    } finally {
      setUploading(false);
      changed();
    }
  }

  return (
    <div className="flex h-svh flex-col">
      <TopBar product="LDrive" person={person} />
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <nav aria-label="Folders" className="flex shrink-0 gap-1 overflow-x-auto border-b p-3 md:w-60 md:flex-col md:border-r md:border-b-0">
          {folders.error && <p className="text-sm text-fail">{folders.error}</p>}
          {folders.data?.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-current={item.id === folder?.id}
              onClick={() => setChosen(item.id)}
              className="flex shrink-0 items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-muted aria-[current=true]:bg-accent aria-[current=true]:font-medium"
            >
              <FolderIcon className="size-4 text-muted-foreground" />
              <span className="flex-1">{item.name}</span>
              <Badge variant="secondary" aria-label={`${item.files} files`}>
                {item.files}
              </Badge>
            </button>
          ))}
        </nav>
        <main className="flex min-w-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
          {folder && (
            <header className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h1 className="font-display text-xl font-semibold">{folder.name}</h1>
                <p className="text-sm text-muted-foreground">Everyone in your company sees this folder.</p>
              </div>
              <input ref={picker} type="file" multiple hidden onChange={upload} aria-label="Files to upload" />
              <Button onClick={() => picker.current?.click()} disabled={uploading}>
                <Upload /> {uploading ? "Uploading" : `Upload to ${folder.name}`}
              </Button>
            </header>
          )}
          {(problem ?? files.error) && (
            <Alert variant="destructive">
              <AlertDescription>{problem ?? files.error}</AlertDescription>
            </Alert>
          )}
          {files.data?.length === 0 && <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">This folder is empty. Upload a file to add it.</p>}
          {files.data && files.data.length > 0 && (
            <div className="rounded-lg border bg-card">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead className="hidden md:table-cell">Uploaded by</TableHead>
                    <TableHead className="hidden sm:table-cell">Added</TableHead>
                    <TableHead className="text-right">Size</TableHead>
                    <TableHead>
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {files.data.map((file) => (
                    <FileRow key={file.id} file={file} person={person} onRemoved={changed} onProblem={setProblem} />
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
