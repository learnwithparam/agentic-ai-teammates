import { ArrowLeft, Inbox, Paperclip, PenSquare, Send } from "lucide-react";
import { type SubmitEvent, useEffect, useRef, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { problemText } from "@/lib/http";
import { dateTime, fileSize, http, type Person, TopBar, useAnswer } from "@/lib/page";
import { Mailboxes, Message, type MessageSummary, Messages } from "./api";

// A mail client: the mailboxes this person may open on the left, the chosen folder in the middle,
// and the open message on the right. On a phone, one of those shows at a time.

type Folder = "inbox" | "sent";

function sender(message: MessageSummary) {
  return message.fromName ? `${message.fromName}` : message.fromAddress;
}

function MessageRow({ message, open, onOpen }: { message: MessageSummary; open: boolean; onOpen: () => void }) {
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        aria-current={open}
        className="flex w-full flex-col gap-0.5 border-b px-4 py-3 text-left hover:bg-muted/60 aria-[current=true]:bg-accent"
      >
        <span className="flex items-center gap-2">
          {message.unread && <span aria-label="Unread" className="size-2 shrink-0 rounded-full bg-primary" />}
          <span className={`min-w-0 flex-1 truncate text-sm ${message.unread ? "font-semibold" : ""}`}>
            {message.folder === "sent" ? `To ${message.to.join(", ")}` : sender(message)}
          </span>
          <time className="shrink-0 text-xs text-muted-foreground">{dateTime.format(new Date(message.receivedAt))}</time>
        </span>
        <span className="flex items-center gap-1.5 text-sm">
          <span className="min-w-0 flex-1 truncate">{message.subject || "(no subject)"}</span>
          {message.attachmentCount > 0 && <Paperclip aria-label={`${message.attachmentCount} attachments`} className="size-3.5 shrink-0 text-muted-foreground" />}
        </span>
        <span className="truncate text-xs text-muted-foreground">{message.preview}</span>
      </button>
    </li>
  );
}

function Reading({ id, onBack, onRead }: { id: string; onBack: () => void; onRead: () => void }) {
  const { data: message, error } = useAnswer(`/api/messages/${encodeURIComponent(id)}`, Message);
  // Opening a message marks it read, so the list and the unread counts load again once.
  const read = useRef(onRead);
  read.current = onRead;
  useEffect(() => {
    if (message) read.current();
  }, [message]);
  if (error) return <p className="p-6 text-sm text-fail">{error}</p>;
  if (!message) return <p className="p-6 text-sm text-muted-foreground">Opening the message.</p>;
  return (
    <article className="flex flex-col gap-4 p-4 sm:p-6">
      <Button variant="ghost" size="sm" className="self-start lg:hidden" onClick={onBack}>
        <ArrowLeft /> Back to the list
      </Button>
      <header className="flex flex-col gap-1 border-b pb-4">
        <h2 className="font-display text-xl font-semibold">{message.subject || "(no subject)"}</h2>
        <p className="text-sm">
          <span className="font-medium">{message.fromName ?? message.fromAddress}</span>{" "}
          {message.fromName && <span className="text-muted-foreground">&lt;{message.fromAddress}&gt;</span>}
        </p>
        <p className="text-xs text-muted-foreground">
          To {message.to.join(", ")}, {dateTime.format(new Date(message.receivedAt))}
        </p>
      </header>
      <pre className="font-sans text-sm leading-relaxed whitespace-pre-wrap">{message.text}</pre>
      {message.attachments.length > 0 && (
        <section aria-label="Attachments" className="flex flex-wrap gap-2 border-t pt-4">
          {message.attachments.map((file) => (
            <a
              key={file.id}
              href={`/api/messages/${encodeURIComponent(message.id)}/attachments/${encodeURIComponent(file.id)}`}
              className="flex items-center gap-2 rounded-md border bg-card px-3 py-2 text-sm hover:bg-muted"
            >
              <Paperclip className="size-4 text-muted-foreground" />
              <span className="max-w-56 truncate">{file.filename}</span>
              <span className="text-xs text-muted-foreground">{fileSize(file.size)}</span>
            </a>
          ))}
        </section>
      )}
    </article>
  );
}

async function asAttachment(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return { filename: file.name, contentType: file.type || "application/octet-stream", base64: btoa(binary) };
}

function Compose({ from, open, onClose, onSent }: { from: string; open: boolean; onClose: () => void; onSent: () => void }) {
  const [problem, setProblem] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const files = form.getAll("attachments").filter((item): item is File => item instanceof File && item.size > 0);
    const to = String(form.get("to")).split(",").map((address) => address.trim()).filter(Boolean);
    setSending(true);
    setProblem(null);
    try {
      const attachments = await Promise.all(files.map(asAttachment));
      await http.post(`/api/mailboxes/${encodeURIComponent(from)}/send`, { to, subject: String(form.get("subject")), text: String(form.get("text")), attachments });
      onSent();
      onClose();
    } catch (error) {
      setProblem(problemText(error, "The mail was not sent. Check the addresses and try again."));
    } finally {
      setSending(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={(next) => !next && onClose()}>
      <SheetContent side="right" className="w-full sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>New message</SheetTitle>
          <SheetDescription>From {from}</SheetDescription>
        </SheetHeader>
        <form onSubmit={submit} className="flex flex-col gap-4 px-4 pb-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="to">To</Label>
            <Input id="to" name="to" type="text" required placeholder="name@example.com, another@example.com" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="subject">Subject</Label>
            <Input id="subject" name="subject" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="text">Message</Label>
            <Textarea id="text" name="text" rows={10} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="attachments">Attach files</Label>
            <Input id="attachments" name="attachments" type="file" multiple />
          </div>
          {problem && (
            <Alert variant="destructive">
              <AlertDescription>{problem}</AlertDescription>
            </Alert>
          )}
          <Button type="submit" disabled={sending} className="self-end">
            <Send /> {sending ? "Sending" : "Send"}
          </Button>
        </form>
      </SheetContent>
    </Sheet>
  );
}

export function Mail({ person }: { person: Person }) {
  const boxes = useAnswer("/api/mailboxes", Mailboxes);
  const [address, setAddress] = useState<string | null>(null);
  const [folder, setFolder] = useState<Folder>("inbox");
  const [openId, setOpenId] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const mailbox = address ?? boxes.data?.find((box) => box.address === person.email)?.address ?? boxes.data?.[0]?.address ?? null;
  const list = useAnswer(mailbox ? `/api/mailboxes/${encodeURIComponent(mailbox)}/messages?folder=${folder}` : null, Messages);
  const { reload: reloadList } = list;
  const { reload: reloadBoxes } = boxes;

  return (
    <div className="flex h-svh flex-col">
      <TopBar product="LMail" person={person}>
        {mailbox && (
          <Button size="sm" onClick={() => setComposing(true)}>
            <PenSquare /> Write
          </Button>
        )}
      </TopBar>
      <div className="flex min-h-0 flex-1">
        <nav aria-label="Mailboxes" className="hidden w-64 shrink-0 flex-col gap-1 overflow-y-auto border-r p-3 md:flex">
          {boxes.error && <p className="text-sm text-fail">{boxes.error}</p>}
          {boxes.data?.map((box) => (
            <button
              key={box.address}
              type="button"
              aria-current={box.address === mailbox}
              onClick={() => {
                setAddress(box.address);
                setOpenId(null);
              }}
              className="flex items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-muted aria-[current=true]:bg-accent aria-[current=true]:font-medium"
            >
              <Inbox className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="block truncate">{box.name}</span>
                <span className="block truncate text-xs text-muted-foreground">{box.address}</span>
              </span>
              {box.unread > 0 && <Badge variant="secondary" aria-label={`${box.unread} unread`}>{box.unread}</Badge>}
            </button>
          ))}
        </nav>
        <section aria-label="Messages" className={`min-w-0 flex-col border-r lg:flex lg:w-96 lg:flex-none ${openId ? "hidden" : "flex flex-1"}`}>
          <div className="flex flex-col gap-2 border-b p-3">
            <select
              aria-label="Mailbox"
              className="h-9 rounded-md border bg-background px-2 text-sm md:hidden"
              value={mailbox ?? ""}
              onChange={(event) => {
                setAddress(event.target.value);
                setOpenId(null);
              }}
            >
              {boxes.data?.map((box) => (
                <option key={box.address} value={box.address}>
                  {box.address}
                </option>
              ))}
            </select>
            <Tabs value={folder} onValueChange={(value) => { setFolder(value as Folder); setOpenId(null); }}>
              <TabsList className="w-full">
                <TabsTrigger value="inbox">Inbox</TabsTrigger>
                <TabsTrigger value="sent">Sent</TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
          {list.error && <p className="p-4 text-sm text-fail">{list.error}</p>}
          {list.data?.length === 0 && <p className="p-6 text-center text-sm text-muted-foreground">{folder === "inbox" ? "No mail here yet. Mail sent to this address lands here." : "Nothing sent from this mailbox yet."}</p>}
          <ul className="min-h-0 flex-1 overflow-y-auto">
            {list.data?.map((message) => (
              <MessageRow key={message.id} message={message} open={message.id === openId} onOpen={() => setOpenId(message.id)} />
            ))}
          </ul>
        </section>
        <main className={`min-w-0 flex-1 overflow-y-auto ${openId ? "block" : "hidden lg:block"}`}>
          {openId ? (
            <Reading
              key={openId}
              id={openId}
              onBack={() => setOpenId(null)}
              onRead={() => {
                reloadList();
                reloadBoxes();
              }}
            />
          ) : (
            <p className="grid h-full place-items-center p-6 text-sm text-muted-foreground">Choose a message to read it.</p>
          )}
        </main>
      </div>
      {mailbox && (
        <Compose
          from={mailbox}
          open={composing}
          onClose={() => setComposing(false)}
          onSent={() => {
            setFolder("sent");
            reloadList();
          }}
        />
      )}
    </div>
  );
}
