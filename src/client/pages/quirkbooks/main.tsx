import { startPage } from "@/lib/page";
import { Books } from "@/quirkbooks/Books";

startPage((person) => <Books person={person} />);
