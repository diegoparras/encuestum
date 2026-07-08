import { redirect } from "next/navigation";

// The admin app lives under /surveys; the bare root just forwards there.
export default function Home() {
  redirect("/surveys");
}
