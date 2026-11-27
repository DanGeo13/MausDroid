// Sign-in values match OpenAI's Codex CLI (codex-cli 0.172.0): its OAuth client, redirect and scopes.
const AUTH = {
  issuer: "https://auth.openai.com",
  clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
  redirectUri: "http://localhost:1455/auth/callback",
  scope: "openid profile email offline_access api.connectors.read api.connectors.invoke",
  originator: "codex_cli_rs",
  clientVersion: "0.172.0",
};
const CODEX_API = "https://chatgpt.com/backend-api/codex";

function base64Url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function jwtClaims(token) {
  try {
    const part = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(part));
  } catch {
    return {};
  }
}

async function buildSignInUrl() {
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(64)));
  const challenge = base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const state = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  await chrome.storage.session.set({ pkce: { verifier, state } });
  const params = new URLSearchParams({
    response_type: "code",
    client_id: AUTH.clientId,
    redirect_uri: AUTH.redirectUri,
    scope: AUTH.scope,
    code_challenge: challenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state,
    originator: AUTH.originator,
  });
  return `${AUTH.issuer}/oauth/authorize?${params}`;
}

function sessionFromTokens(tokens, previous = {}) {
  const idToken = tokens.id_token ?? previous.idToken;
  const claims = jwtClaims(idToken);
  const accessClaims = jwtClaims(tokens.access_token);
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? previous.refreshToken,
    idToken,
    accountId: claims["https://api.openai.com/auth"]?.chatgpt_account_id ?? previous.accountId,
    email: claims.email ?? previous.email,
    expiresAt: accessClaims.exp ? accessClaims.exp * 1000 : Date.now() + (tokens.expires_in ?? 3600) * 1000,
  };
}

async function exchangeCode(code) {
  const { pkce } = await chrome.storage.session.get("pkce");
  if (!pkce) throw new Error("Sign-in expired. Try again.");
  const res = await fetch(`${AUTH.issuer}/oauth/token`, {
    method: "POST",
    credentials: "omit",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: AUTH.redirectUri,
      client_id: AUTH.clientId,
      code_verifier: pkce.verifier,
    }),
  });
  if (!res.ok) throw new Error(`Sign-in failed (${res.status}): ${await res.text()}`);
  await chrome.storage.session.remove("pkce");
  const session = sessionFromTokens(await res.json());
  await chrome.storage.local.set({ session });
  return session;
}

async function refreshSession(session) {
  const res = await fetch(`${AUTH.issuer}/oauth/token`, {
    method: "POST",
    credentials: "omit",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_id: AUTH.clientId,
      grant_type: "refresh_token",
      refresh_token: session.refreshToken,
      scope: "openid profile email",
    }),
  });
  if (!res.ok) {
    await chrome.storage.local.remove("session");
    throw new Error("Your ChatGPT sign-in expired. Click 'Sign in with ChatGPT' again.");
  }
  const fresh = sessionFromTokens(await res.json(), session);
  await chrome.storage.local.set({ session: fresh });
  return fresh;
}

async function getSession() {
  const { session } = await chrome.storage.local.get("session");
  if (!session) return null;
  if (Date.now() < session.expiresAt - 5 * 60_000) return session;
  return refreshSession(session);
}

async function codexHeaders(session) {
  return {
    authorization: `Bearer ${session.accessToken}`,
    "chatgpt-account-id": session.accountId ?? "",
    "openai-beta": "responses=experimental",
    originator: AUTH.originator,
  };
}
