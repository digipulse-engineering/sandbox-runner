const encoder = new TextEncoder();

export async function witnessPath(control, id, source) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(control), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(`vitest-witness/${id}/${source}`)));
  const nonce = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
  return `/witness/${id}/${source}/${nonce}`;
}
