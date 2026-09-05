/**
 * The organiser gate.
 *
 * Up to v5 there was one page and everybody used it: the same screen that
 * generated a schedule also published it, so anyone who found the site could
 * replace the club's mixer. v6 splits the app in two. Members get the root
 * URL, which only ever reads. Generating and publishing move behind this gate.
 *
 * Two locks, both from environment variables, because the club asked for a
 * link they can keep rather than an account system:
 *
 *   ADMIN_PATH   an unguessable path segment - /admin/<ADMIN_PATH>
 *   ADMIN_PIN    typed once per device, then remembered in a cookie
 *
 * The path alone hides the page from anyone sweeping the site; the PIN is what
 * still protects it if the link is forwarded to the wrong WhatsApp group. A
 * brute-force attempt on the PIN has to know the path first, which is why a
 * short PIN is defensible here.
 *
 * Everything below is pure apart from reading `process.env`, so the whole gate
 * is testable from a script with no server running. Reading and writing the
 * cookie belongs to the route handlers, which is also what keeps this file
 * free of `next/headers` and therefore importable from tests.
 */
import { createHash, timingSafeEqual } from "node:crypto";

export const ADMIN_COOKIE = "rstc_admin";

/** A month: long enough that an organiser sets up a mixer without retyping. */
export const ADMIN_COOKIE_MAX_AGE = 60 * 60 * 24 * 30;

export interface AdminConfig {
  path: string;
  pin: string;
  /** Is the secret path set, so a wrong URL 404s? */
  pathSet: boolean;
  /** Is a PIN set, so the page asks for one? */
  pinSet: boolean;
  /** Neither lock configured: the admin area is wide open. */
  open: boolean;
}

/**
 * Read at call time, not at module load, so a test can set the variables and
 * so a redeployed environment variable takes effect without a rebuild.
 */
export function adminConfig(): AdminConfig {
  const path = (process.env.ADMIN_PATH ?? "").trim();
  const pin = (process.env.ADMIN_PIN ?? "").trim();
  const pathSet = path.length > 0;
  const pinSet = pin.length > 0;
  return { path, pin, pathSet, pinSet, open: !pathSet && !pinSet };
}

/**
 * Constant-time string comparison. Both sides are hashed first so that the
 * comparison is always over 32 bytes and the length of the secret does not
 * leak through the length of the comparison.
 */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(sha256(a), sha256(b));
}

function sha256(s: string): Buffer {
  return createHash("sha256").update(s, "utf8").digest();
}

/**
 * Does this URL segment match the configured secret path?
 *
 * With no ADMIN_PATH set every non-empty segment matches, which is what makes
 * `npm run dev` usable on a laptop. That is also why an unconfigured
 * deployment must be treated as unprotected - the admin page says so on screen.
 */
export function checkToken(token: string): boolean {
  const { path, pathSet } = adminConfig();
  if (!pathSet) return token.length > 0;
  return safeEqual(token, path);
}

/** Is the PIN the organiser typed the right one? */
export function checkPin(pin: string): boolean {
  const { pin: want, pinSet } = adminConfig();
  if (!pinSet) return true;
  return safeEqual(pin, want);
}

/**
 * The value stored in the unlock cookie: a hash of both secrets, so the cookie
 * cannot be forged without knowing them and every cookie stops working the
 * moment either secret is rotated.
 */
export function adminCookieValue(): string {
  const { path, pin } = adminConfig();
  return createHash("sha256")
    .update(`rstc-admin:v1:${path}:${pin}`, "utf8")
    .digest("hex");
}

/** Is this cookie value a current unlock? */
export function checkCookie(value: string | undefined): boolean {
  const { pinSet } = adminConfig();
  if (!pinSet) return true; // Nothing to unlock.
  if (!value) return false;
  return safeEqual(value, adminCookieValue());
}

/**
 * Pull one cookie out of a raw `Cookie:` header.
 *
 * Route handlers get the request, so they read the header directly and this
 * file stays free of `next/headers`; the admin page is a server component with
 * no request in hand and uses `cookies()` instead.
 */
export function readCookie(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

/** Is this request carrying a valid unlock cookie? */
export function isAdminRequest(request: Request): boolean {
  return checkCookie(readCookie(request.headers.get("cookie"), ADMIN_COOKIE));
}

/** The `Set-Cookie` value that unlocks the admin area on this device. */
export function unlockCookieHeader(): string {
  return cookieHeader(adminCookieValue(), ADMIN_COOKIE_MAX_AGE);
}

/** The `Set-Cookie` value that locks it again. */
export function lockCookieHeader(): string {
  return cookieHeader("", 0);
}

function cookieHeader(value: string, maxAge: number): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return (
    `${ADMIN_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`
  );
}
