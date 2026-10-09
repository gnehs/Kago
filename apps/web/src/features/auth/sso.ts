import { useEffect, useRef, useState } from "react";
import { api } from "@/api/client";
import { t } from "@/lib/i18n";
import { toast } from "@/stores/toast";
import type { SsoInfo } from "@/types/kago";

/**
 * Why a sign-in through the identity provider did not go through. The server sends the browser back with only the
 * code of what went wrong; the wording is the one it uses for the same error elsewhere.
 */
const failures: Record<string, string> = {
  OIDC_DISABLED: t("Single sign-on is not set up"),
  OIDC_FLOW_INVALID: t("This sign-in was not started from this browser, or took too long"),
  OIDC_PROVIDER_REFUSED: t("The identity provider did not sign you in"),
  OIDC_PROVIDER_UNREACHABLE: t("Could not reach the identity provider"),
  OIDC_DISCOVERY_FAILED: t("That address does not answer as an OpenID Connect provider"),
  OIDC_ISSUER_MISMATCH: t("The provider names a different issuer than the one entered"),
  OIDC_PKCE_UNSUPPORTED: t("The provider does not support PKCE with S256"),
  OIDC_TOKEN_FAILED: t("The identity provider did not complete the sign-in"),
  OIDC_TOKEN_INVALID: t("The identity provider’s answer could not be verified"),
  OIDC_NOT_LINKED: t("No Kago account is linked to this identity yet. Sign in with your password, then link it under Settings."),
  OIDC_EMAIL_MISSING: t("The identity provider did not share an email address"),
  OIDC_EMAIL_IN_USE: t("A Kago account with this email already exists; sign in to it and link the identity from Settings"),
  OIDC_LINK_SESSION: t("Sign in to Kago again before linking an identity"),
  OIDC_IDENTITY_TAKEN: t("This identity is already linked to another Kago account"),
  ACCOUNT_DISABLED: t("This account is disabled"),
  TOO_MANY_ATTEMPTS: t("Too many attempts; try again later")
};

export const ssoErrorMessage = (code: string) => failures[code] ?? t("Single sign-on failed");

/** What the button that starts a sign-in at the provider says. */
export const ssoLabel = (sso: SsoInfo) => (sso.name ? t("Sign in with {name}", { name: sso.name }) : t("Sign in with single sign-on"));

/** Where the provider is asked to send someone back to: the page they were after, unless that is the sign-in page itself. */
export function ssoStartUrl(): string {
  const returnTo = location.pathname === "/login" ? "/" : `${location.pathname}${location.search}`;
  return `/api/auth/oidc/start?${new URLSearchParams({ returnTo }).toString()}`;
}

// Someone who has just signed out is not sent straight back in by the provider's own session. Kept for the tab only.
const SIGNED_OUT = "kago.signed-out";

export function markSignedOut(): void {
  try {
    sessionStorage.setItem(SIGNED_OUT, "1");
  } catch {
    // Without storage the sign-in page simply goes on to the provider, as if freshly opened.
  }
}

export function signedOutHere(): boolean {
  try {
    return sessionStorage.getItem(SIGNED_OUT) === "1";
  } catch {
    return false;
  }
}

function clearSignedOut(): void {
  try {
    sessionStorage.removeItem(SIGNED_OUT);
  } catch {
    // Nothing was stored to begin with.
  }
}

/** What the address said about a sign-in that has just come back from the provider, read before anything rewrites it. */
export function readSsoReturn(): { linked: boolean; error: string | null } {
  const params = new URLSearchParams(location.search);
  return { linked: params.get("sso") === "linked", error: params.get("sso_error") };
}

/**
 * Tells someone who is signed in how linking an identity went. `signedIn` is undefined until it is known; a failure
 * that leaves nobody signed in is the sign-in page's to show instead.
 */
export function useSsoNotice(signedIn: boolean | undefined): void {
  const [came] = useState(readSsoReturn);
  const settled = useRef(false);

  useEffect(() => {
    if (signedIn === undefined) return;
    if (signedIn) clearSignedOut();
    if (settled.current) return;
    settled.current = true;
    if (!signedIn) return;
    if (came.linked) toast(t("The identity is now linked to your account"));
    else if (came.error) toast(ssoErrorMessage(came.error), "error");
  }, [signedIn, came]);
}

/** Sends the browser to the provider to link the identity it comes back with to the account signed in. */
export async function startSsoLink(): Promise<void> {
  const { url } = await api<{ url: string }>("/api/auth/oidc/link", { method: "POST" });
  location.assign(url);
}
