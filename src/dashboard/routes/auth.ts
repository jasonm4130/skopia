/** Skopia — first-run setup, login and logout routes. */

import type { Hono } from "hono";
import { getOwner } from "../../db/queries";
import { requireSecrets, SecretsMissingError } from "../../shared/config";
import {
  COOKIE_MAX_AGE,
  COOKIE_NAME,
  DUMMY_PW_HASH,
  hashPassword,
  parseCookies,
  signCookie,
  verifyCookie,
  verifyPassword,
} from "../auth";
import type { DashEnv } from "../env";
import { loginPage, notConfiguredPage, setupPage } from "../render/pages";

export function registerAuthRoutes(dashboard: Hono<DashEnv>): void {
  // ---------------------------------------------------------------------------
  // Routes: first-run setup
  // ---------------------------------------------------------------------------

  dashboard.get("/setup", async (c) => {
    // If owner already exists, redirect to /login
    const owner = await getOwner(c.env.DB);
    if (owner) return c.redirect("/login");
    return c.html(setupPage(c.get("nonce")));
  });

  dashboard.post("/setup", async (c) => {
    const owner = await getOwner(c.env.DB);
    if (owner) return c.redirect("/login");

    const form = await c.req.formData();
    const email = (form.get("email") as string | null)?.trim() ?? "";
    const password = (form.get("password") as string | null) ?? "";
    const confirm = (form.get("confirm") as string | null) ?? "";

    const nonce = c.get("nonce");
    if (!email || !password) {
      const missing: string[] = [];
      if (!email) missing.push("email");
      if (!password) missing.push("password");
      return c.html(setupPage(nonce, "Email and password are required.", email, missing), 400);
    }
    if (password.length < 8) {
      return c.html(
        setupPage(nonce, "Password must be at least 8 characters.", email, ["password"]),
        400,
      );
    }
    if (password !== confirm) {
      return c.html(
        setupPage(nonce, "Passwords do not match.", email, ["password", "confirm"]),
        400,
      );
    }

    const pwHash = await hashPassword(password);
    // Race guard: two concurrent first-run POSTs both pass the getOwner() check
    // above before either INSERTs. A single conditional statement (SELECT ...
    // WHERE NOT EXISTS) makes "is there already an owner" and "insert the
    // owner" atomic in D1, instead of two round trips a second request can
    // interleave between. `meta.changes === 0` means another request already
    // won the race — behave exactly like the getOwner() check above.
    const result = await c.env.DB.prepare(
      `INSERT INTO users (email, pw_hash, role, created_at)
       SELECT ?, ?, 'owner', unixepoch()
       WHERE NOT EXISTS (SELECT 1 FROM users WHERE role = 'owner')`,
    )
      .bind(email, pwHash)
      .run();

    if (result.meta.changes === 0) {
      // Another request already won the race and created the owner — same
      // response as the getOwner() check above.
      return c.redirect("/login");
    }
    return c.redirect("/login");
  });

  // ---------------------------------------------------------------------------
  // Routes: login / logout
  // ---------------------------------------------------------------------------

  dashboard.get("/login", async (c) => {
    // Fail closed: an unset AUTH_COOKIE_SECRET on a cold deploy would make the
    // cookie check below throw (undefined/"" HMAC key) and surface a 500 instead
    // of the login page. Guard before verifyCookie.
    try {
      requireSecrets(c.env, ["AUTH_COOKIE_SECRET"]);
    } catch (err) {
      if (err instanceof SecretsMissingError) {
        return c.html(notConfiguredPage(c.get("nonce"), err.missing), 500);
      }
      throw err;
    }

    // Already authed?
    const cookies = parseCookies(c.req.header("cookie") ?? null);
    const cookieVal = cookies[COOKIE_NAME];
    if (cookieVal) {
      const userId = await verifyCookie(cookieVal, c.env.AUTH_COOKIE_SECRET);
      if (userId !== null) return c.redirect("/app");
    }

    // No owner yet?
    const owner = await getOwner(c.env.DB);
    if (!owner) return c.redirect("/setup");

    return c.html(loginPage(c.get("nonce")));
  });

  dashboard.post("/login", async (c) => {
    const owner = await getOwner(c.env.DB);
    if (!owner) return c.redirect("/setup");

    const nonce = c.get("nonce");

    // Fail closed: never sign a session cookie with an unset key (forgeable
    // sessions). Surface a clear "not configured" page instead of a 500.
    try {
      requireSecrets(c.env, ["AUTH_COOKIE_SECRET"]);
    } catch (err) {
      if (err instanceof SecretsMissingError) {
        return c.html(notConfiguredPage(nonce, err.missing), 500);
      }
      throw err;
    }

    const form = await c.req.formData();
    const email = (form.get("email") as string | null)?.trim() ?? "";
    const password = (form.get("password") as string | null) ?? "";

    // Always pay the PBKDF2 cost, even on an email mismatch — checking
    // `emailMatches && verifyPassword(...)` would short-circuit on mismatch,
    // making the response time an oracle for whether an email is the owner's.
    const emailMatches = email.toLowerCase() === owner.email.toLowerCase();
    const passwordOk = await verifyPassword(password, emailMatches ? owner.pw_hash : DUMMY_PW_HASH);
    const valid = emailMatches && passwordOk;

    if (!valid) {
      return c.html(loginPage(nonce, "Invalid email or password.", email), 401);
    }

    const expiry = Date.now() + COOKIE_MAX_AGE * 1000;
    const cookieVal = await signCookie(owner.id, expiry, c.env.AUTH_COOKIE_SECRET);

    c.header(
      "Set-Cookie",
      `${COOKIE_NAME}=${encodeURIComponent(cookieVal)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${COOKIE_MAX_AGE}`,
    );
    return c.redirect("/app");
  });

  dashboard.get("/logout", (c) => {
    c.header("Set-Cookie", `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`);
    return c.redirect("/login");
  });
}
