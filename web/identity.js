// Phase-0 stub identity for the client. Real auth (login/session) replaces this.
// You "act as" a person id, sent on every request so the server can resolve a
// Principal and enforce access. Persisted in localStorage (shared across the
// same-origin setup/scorer/follower pages); overridable via ?as=<personId>.
const KEY = "clutch:personId";

export function currentPersonId() {
  try {
    const q = new URLSearchParams(location.search).get("as");
    if (q) { localStorage.setItem(KEY, q); return q; }
    return localStorage.getItem(KEY) || "";
  } catch { return new URLSearchParams(location.search).get("as") || ""; }
}

export function setPersonId(id) { try { localStorage.setItem(KEY, id || ""); } catch { /* ignore */ } }

/** Headers to attach to fetch() so the server knows who's acting. */
export function authHeaders(extra) {
  const h = extra ? { ...extra } : {};
  const id = currentPersonId();
  if (id) h["X-Person-Id"] = id;
  return h;
}

/** Append the person id as a query param (for EventSource, which can't set headers). */
export function withPerson(url) {
  const id = currentPersonId();
  if (!id) return url;
  return url + (url.includes("?") ? "&" : "?") + "personId=" + encodeURIComponent(id);
}
