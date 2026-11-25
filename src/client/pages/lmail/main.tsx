import { startPage } from "@/lib/page";
import { Mail } from "@/lmail/Mail";

startPage((person) => <Mail person={person} />);
