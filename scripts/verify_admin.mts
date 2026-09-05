/**
 * Checks the organiser gate: which URLs open, which PINs unlock, and what the
 * cookie is worth once a secret is rotated.
 *
 * The gate is the only thing standing between a club WhatsApp group and the
 * publish button, so it is worth testing the wrong answers as carefully as the
 * right ones. Everything here is pure apart from `process.env`, so no server
 * runs.
 *
 * Run with: npx tsx scripts/verify_admin.mts
 */
import {
  ADMIN_COOKIE,
  adminConfig,
  adminCookieValue,
  checkCookie,
  checkPin,
  checkToken,
  isAdminRequest,
  lockCookieHeader,
  readCookie,
  safeEqual,
  unlockCookieHeader,
} from "../lib/admin";

let failures = 0;
function check(label: string, cond: boolean, detail = "") {
  if (cond) console.log(`ok   ${label}`);
  else {
    failures += 1;
    console.log(`FAIL ${label}${detail ? `\n     ${detail}` : ""}`);
  }
}

/** Run a block with a given configuration, then put the environment back. */
function withEnv(path: string | undefined, pin: string | undefined, body: () => void) {
  const before = { path: process.env.ADMIN_PATH, pin: process.env.ADMIN_PIN };
  if (path === undefined) delete process.env.ADMIN_PATH;
  else process.env.ADMIN_PATH = path;
  if (pin === undefined) delete process.env.ADMIN_PIN;
  else process.env.ADMIN_PIN = pin;
  try {
    body();
  } finally {
    if (before.path === undefined) delete process.env.ADMIN_PATH;
    else process.env.ADMIN_PATH = before.path;
    if (before.pin === undefined) delete process.env.ADMIN_PIN;
    else process.env.ADMIN_PIN = before.pin;
  }
}

const req = (cookie: string | null) =>
  new Request("https://example.test/api/events", {
    method: "POST",
    headers: cookie ? { cookie } : {},
  });

// ---- constant-time comparison ----------------------------------------------
check("equal strings compare equal", safeEqual("hunter2", "hunter2"));
check("different strings do not", !safeEqual("hunter2", "hunter3"));
check("a prefix is not a match", !safeEqual("hunter", "hunter2"));
check("a longer guess is not a match", !safeEqual("hunter22", "hunter2"));
check("empty compares equal to empty", safeEqual("", ""));
check("empty does not match a secret", !safeEqual("", "hunter2"));
check("unicode is handled by bytes, not code units", !safeEqual("é", "e"));

// ---- a fully configured deployment (the production case) -------------------
withEnv("7f3a91c2d4e8", "8461", () => {
  const cfg = adminConfig();
  check("both locks report as configured", cfg.pathSet && cfg.pinSet && !cfg.open);

  check("the right path opens the route", checkToken("7f3a91c2d4e8"));
  check("a wrong path does not", !checkToken("7f3a91c2d4e9"));
  check("a guessed /admin path does not", !checkToken("admin"));
  check("an empty path does not", !checkToken(""));
  check("the path is case sensitive", !checkToken("7F3A91C2D4E8"));

  check("the right PIN unlocks", checkPin("8461"));
  check("a wrong PIN does not", !checkPin("8462"));
  check("an empty PIN does not", !checkPin(""));
  check("a PIN with whitespace does not", !checkPin(" 8461"));

  const value = adminCookieValue();
  check("the cookie value is a sha256 hex digest", /^[0-9a-f]{64}$/.test(value));
  check("neither secret appears in the cookie", !value.includes("8461") && !value.includes("7f3a91c2d4e8"));
  check("the cookie unlocks", checkCookie(value));
  check("no cookie does not", !checkCookie(undefined));
  check("an empty cookie does not", !checkCookie(""));
  check("a made-up cookie does not", !checkCookie("0".repeat(64)));

  // What the route handlers actually see.
  check("a request with the cookie is an organiser", isAdminRequest(req(`${ADMIN_COOKIE}=${value}`)));
  check(
    "the cookie is found among others",
    isAdminRequest(req(`theme=dark; ${ADMIN_COOKIE}=${value}; other=1`))
  );
  check("a request with no cookies is not", !isAdminRequest(req(null)));
  check("a request with only other cookies is not", !isAdminRequest(req("theme=dark")));
  check(
    "a cookie whose name merely ends the same is not accepted",
    !isAdminRequest(req(`x_${ADMIN_COOKIE}=${value}`))
  );

  const set = unlockCookieHeader();
  check("the unlock cookie is httpOnly", /HttpOnly/i.test(set));
  check("the unlock cookie is same-site", /SameSite=Lax/i.test(set));
  check("the unlock cookie is site-wide", /Path=\//.test(set));
  check("the unlock cookie expires", /Max-Age=\d+/.test(set) && !/Max-Age=0/.test(set));
  check("locking again expires it immediately", /Max-Age=0/.test(lockCookieHeader()));
});

// ---- rotating a secret ------------------------------------------------------
{
  let issued = "";
  withEnv("7f3a91c2d4e8", "8461", () => {
    issued = adminCookieValue();
  });
  withEnv("7f3a91c2d4e8", "9999", () => {
    check("changing the PIN invalidates every cookie already out there", !checkCookie(issued));
  });
  withEnv("newpath0000", "8461", () => {
    check("changing the path invalidates them too", !checkCookie(issued));
  });
}

// ---- a half-configured deployment ------------------------------------------
withEnv("7f3a91c2d4e8", undefined, () => {
  check("with no PIN the path alone still gates the route", !checkToken("wrong"));
  check("with no PIN nothing needs unlocking", checkPin("") && checkCookie(undefined));
  check("with no PIN any request is an organiser", isAdminRequest(req(null)));
});

withEnv(undefined, "8461", () => {
  check("with no path any segment reaches the page", checkToken("anything"));
  check("but the PIN still has to be right", !checkPin("0000"));
  check("and a request without the cookie is refused", !isAdminRequest(req(null)));
});

// ---- an unconfigured deployment (a laptop running `npm run dev`) -----------
withEnv(undefined, undefined, () => {
  check("both locks report as open", adminConfig().open);
  check("any non-empty segment opens the page", checkToken("dev"));
  check("an empty segment still does not", !checkToken(""));
  check("nothing needs unlocking", checkPin("whatever") && isAdminRequest(req(null)));
});

// Blank strings are the shape a forgotten Vercel variable actually takes.
withEnv("", "   ", () => {
  check("blank variables count as unset, not as a blank secret", adminConfig().open);
});

// ---- cookie parsing ---------------------------------------------------------
check("a missing header yields nothing", readCookie(null, "a") === undefined);
check("a single cookie is read", readCookie("a=1", "a") === "1");
check("surrounding spaces are trimmed", readCookie(" a = 1 ; b=2", "a") === "1");
check("spaces after the separator are ignored", readCookie("b=2; a=1", "a") === "1");
check("a value containing = survives", readCookie("a=x=y", "a") === "x=y");
check("percent-encoding is decoded", readCookie("a=x%20y", "a") === "x y");
check("a name that is a suffix of another is not confused", readCookie("ba=1", "a") === undefined);
check("an absent cookie yields nothing", readCookie("b=2", "a") === undefined);

console.log(failures ? `\n${failures} failure(s)` : "\nAll admin gate checks passed.");
process.exit(failures ? 1 : 0);
