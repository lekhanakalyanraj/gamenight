import { expect, test } from "@playwright/test";

// Every page sends the security headers, the CSP nonce reaches Next's scripts (so React still
// runs), and the browser reports no CSP violations.

const PAGES = ["/", "/join", "/login", "/tv"];

for (const path of PAGES) {
  test(`${path} is served with security headers and runs under its CSP`, async ({ page }) => {
    const violations: string[] = [];
    page.on("console", (msg) => {
      if (/Content Security Policy|Refused to (load|execute|connect|apply)/i.test(msg.text())) violations.push(msg.text());
    });

    const response = await page.goto(path);
    const headers = response?.headers() ?? {};
    const csp = headers["content-security-policy"] ?? "";
    expect(csp).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'/);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["x-frame-options"]).toBe("DENY");
    expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(headers["permissions-policy"]).toContain("camera=()");

    // Hydration proves Next's scripts carried the nonce; /tv also exercises Supabase through connect-src.
    if (path === "/tv") await expect(page.getByTestId("pairing-code")).toHaveText(/^[A-Z0-9]{6}$/);
    else await page.waitForLoadState("networkidle");
    expect(violations).toEqual([]);
  });
}
