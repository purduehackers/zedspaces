/** Shared by browser diagnostics and the server log sink; never imports server configuration. */
export function scrubSecrets(text: string): string {
  return text
    .replace(/zsb_[A-Za-z0-9_-]{20,}/g, "zsb_[redacted]")
    .replace(/\bgh[opsur]_[A-Za-z0-9]{20,}\b/g, "gh_[redacted]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "github_pat_[redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[jwt-redacted]")
    .replace(/\bv1\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g, "v1.[redacted]")
    .replace(/(:\/\/)[^/@\s]+@/g, "$1[redacted]@")
    .replace(/(zs_port_(?:token|session)=)[^&;\s]+/gi, "$1[redacted]")
    .replace(/(\bbearer(?:\s+|[=:]\s*))[A-Za-z0-9._~+\/-]+=*/gi, "$1[redacted]")
    .replace(/(x-vercel-protection-bypass[=:]\s*)[^&;\s]+/gi, "$1[redacted]");
}

/** Strip credentials and the entire query/fragment, including unknown token formats. */
export function diagnosticUrl(value: string): string {
  try {
    const url = new URL(value);
    return /^(https?|wss?):$/.test(url.protocol)
      ? scrubSecrets(url.origin + url.pathname).slice(0, 512)
      : `${url.protocol}[redacted]`;
  } catch {
    return "[invalid URL]";
  }
}

export function diagnosticText(value: unknown, limit = 2048): string {
  let text: string;
  try { text = value instanceof Error ? value.message : String(value); }
  catch { return "[unprintable error]"; }
  return scrubSecrets(text.replace(/(?:https?|wss?|blob|data):[^\s<>"']+/g, diagnosticUrl)).slice(0, limit);
}
