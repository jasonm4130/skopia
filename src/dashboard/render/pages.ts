/** Skopia — standalone pages: login, setup, not-configured, and the share 404. */

import { esc } from "./html";
import { htmlDoc, skopiaLogo } from "./layout";

// ---------------------------------------------------------------------------
// Login / setup pages
// ---------------------------------------------------------------------------

export function loginPage(nonce: string, error?: string, email?: string): string {
  const errorHtml = error
    ? `<div id="login-error" role="alert" style="color:#e08571;font-size:13px;margin-bottom:16px;">${esc(error)}</div>`
    : "";
  // On a failed POST, mark the fields invalid and point them at the error
  // banner (WCAG 3.3.1), and keep the entered email so it isn't retyped.
  const invalid = error ? ` aria-invalid="true" aria-describedby="login-error"` : "";
  const emailVal = email ? ` value="${esc(email)}"` : "";
  return htmlDoc(
    "Login",
    "",
    `<main style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px 16px;">
    <div style="width:100%;max-width:360px;">
      <div style="display:flex;align-items:center;gap:9px;margin-bottom:32px;justify-content:center;">
        ${skopiaLogo()}
        <span style="font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:20px;color:#fff;">Skopia</span>
      </div>
      <div style="background:#12151d;border:1px solid #20252f;border-radius:14px;padding:32px;">
        <h1 style="font-family:'Space Grotesk',sans-serif;font-weight:600;font-size:18px;color:#fff;margin-bottom:24px;">Sign in</h1>
        ${errorHtml}
        <form method="post" action="/login">
          <div style="margin-bottom:16px;">
            <label for="login-email" style="display:block;font-size:13px;color:#9aa1b2;margin-bottom:6px;">Email</label>
            <input id="login-email" name="email" type="email" autocomplete="email" required${emailVal}${invalid} style="width:100%;background:#0d1016;border:1px solid #262b38;border-radius:8px;padding:10px 12px;font-size:14px;color:#e8eaef;">
          </div>
          <div style="margin-bottom:24px;">
            <label for="login-password" style="display:block;font-size:13px;color:#9aa1b2;margin-bottom:6px;">Password</label>
            <input id="login-password" name="password" type="password" autocomplete="current-password" required${invalid} style="width:100%;background:#0d1016;border:1px solid #262b38;border-radius:8px;padding:10px 12px;font-size:14px;color:#e8eaef;">
          </div>
          <button type="submit" style="width:100%;background:#3568d6;color:#fff;border:none;border-radius:8px;padding:11px;font-size:14px;font-weight:600;cursor:pointer;">Sign in</button>
        </form>
      </div>
    </div>
  </main>`,
    nonce,
  );
}

/**
 * Fail-closed "not configured" page (HTTP 500). Shown when a required deploy
 * secret is unset, instead of signing a cookie with `undefined`.
 */
export function notConfiguredPage(nonce: string, missing: string[]): string {
  const names = missing
    .map(
      (m) => `<code style="font-family:'JetBrains Mono',monospace;color:#9fb4ff;">${esc(m)}</code>`,
    )
    .join(", ");
  return htmlDoc(
    "Not configured",
    "",
    `<main style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px 16px;">
    <div style="width:100%;max-width:440px;background:#12151d;border:1px solid #20252f;border-radius:14px;padding:32px;">
      <h1 style="font-family:'Space Grotesk',sans-serif;font-weight:600;font-size:18px;color:#fff;margin-bottom:12px;">Not configured</h1>
      <div style="font-size:13.5px;color:#cfd4e0;line-height:1.6;margin-bottom:14px;">
        This Skopia instance is missing required secret${missing.length > 1 ? "s" : ""}: ${names}.
        Sessions cannot be signed safely until ${missing.length > 1 ? "they are" : "it is"} set.
      </div>
      <div style="font-size:13px;color:#9aa1b2;line-height:1.6;">
        Generate a key with <code style="font-family:'JetBrains Mono',monospace;color:#9fb4ff;">openssl rand -hex 32</code>
        and set it as an encrypted secret, then redeploy. See the deploy docs (README).
      </div>
    </div>
  </main>`,
    nonce,
  );
}

export function setupPage(
  nonce: string,
  error?: string,
  email?: string,
  invalidFields: readonly string[] = [],
): string {
  const errorHtml = error
    ? `<div id="setup-error" role="alert" style="color:#e08571;font-size:13px;margin-bottom:16px;">${esc(error)}</div>`
    : "";
  // Only the field(s) that actually failed get aria-invalid — marking a valid
  // field invalid misleads assistive tech (e.g. the email on a password mismatch).
  const invalidAttr = (field: string): string =>
    invalidFields.includes(field) ? ` aria-invalid="true" aria-describedby="setup-error"` : "";
  const emailVal = email ? ` value="${esc(email)}"` : "";
  return htmlDoc(
    "Setup",
    "",
    `<main style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px 16px;">
    <div style="width:100%;max-width:400px;">
      <div style="display:flex;align-items:center;gap:9px;margin-bottom:32px;justify-content:center;">
        ${skopiaLogo()}
        <span style="font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:20px;color:#fff;">Skopia</span>
      </div>
      <div style="background:#12151d;border:1px solid #20252f;border-radius:14px;padding:32px;">
        <h1 style="font-family:'Space Grotesk',sans-serif;font-weight:600;font-size:18px;color:#fff;margin-bottom:8px;">Welcome to Skopia</h1>
        <div style="font-size:13px;color:#9aa1b2;margin-bottom:24px;">Create your owner account to get started.</div>
        ${errorHtml}
        <form method="post" action="/setup">
          <div style="margin-bottom:16px;">
            <label for="setup-email" style="display:block;font-size:13px;color:#9aa1b2;margin-bottom:6px;">Email</label>
            <input id="setup-email" name="email" type="email" autocomplete="email" required${emailVal}${invalidAttr("email")} style="width:100%;background:#0d1016;border:1px solid #262b38;border-radius:8px;padding:10px 12px;font-size:14px;color:#e8eaef;">
          </div>
          <div style="margin-bottom:16px;">
            <label for="setup-password" style="display:block;font-size:13px;color:#9aa1b2;margin-bottom:6px;">Password</label>
            <input id="setup-password" name="password" type="password" autocomplete="new-password" minlength="8" required${invalidAttr("password")} style="width:100%;background:#0d1016;border:1px solid #262b38;border-radius:8px;padding:10px 12px;font-size:14px;color:#e8eaef;">
          </div>
          <div style="margin-bottom:24px;">
            <label for="setup-confirm" style="display:block;font-size:13px;color:#9aa1b2;margin-bottom:6px;">Confirm Password</label>
            <input id="setup-confirm" name="confirm" type="password" autocomplete="new-password" required${invalidAttr("confirm")} style="width:100%;background:#0d1016;border:1px solid #262b38;border-radius:8px;padding:10px 12px;font-size:14px;color:#e8eaef;">
          </div>
          <button type="submit" style="width:100%;background:#3568d6;color:#fff;border:none;border-radius:8px;padding:11px;font-size:14px;font-weight:600;cursor:pointer;">Create account</button>
        </form>
      </div>
    </div>
  </main>`,
    nonce,
  );
}
