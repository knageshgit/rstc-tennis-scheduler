/**
 * /admin on its own is not a page.
 *
 * The organiser URL carries a secret path segment, and a helpful "you need the
 * full link" message here would confirm to anyone poking at the site that an
 * admin area exists. So this behaves exactly like any other unused URL.
 */
import { notFound } from "next/navigation";

export default function AdminIndex(): never {
  notFound();
}
