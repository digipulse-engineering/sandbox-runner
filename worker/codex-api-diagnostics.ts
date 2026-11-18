export const codexApiCreditPromoRestriction = "provider_codex_api_credit_promo_restricted";
const upstreamCode = "codex_byok_restricted_by_api_credit_promo";
// Inspect only small structured error envelopes. Larger bodies still reach Codex unchanged.
const errorEnvelopeBytes = 16 * 1024;

export function observeCodexApiRejection(response: Response, onRestriction: () => Promise<void>): Response {
  const { body, headers, status } = response;
  if (status !== 400 || !body || headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json" ||
      Number(headers.get("content-length")) > errorEnvelopeBytes) return response;

  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  let bytes = 0;
  let envelope: string | undefined = "";
  // Use the downstream reader's backpressure. Send each chunk unchanged, and
  // await the fixed diagnostic only at EOF so the terminal result can see it.
  const observed = body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, stream) {
      if (envelope !== undefined) {
        bytes += chunk.byteLength;
        try {
          envelope = bytes > errorEnvelopeBytes ? undefined : envelope + decoder.decode(chunk, { stream: true });
        } catch {
          envelope = undefined;
        }
      }
      stream.enqueue(chunk);
    },
    async flush() {
      if (envelope === undefined) return;
      try {
        const payload = JSON.parse(envelope + decoder.decode());
        if (payload?.error?.code === upstreamCode) await onRestriction();
      } catch {
        // A malformed or unavailable diagnostic must never change the response.
      }
    },
  }));
  const forwarded = new Response(observed, response);
  // A fixed length would let a client finish before the transform's flush.
  forwarded.headers.delete("content-length");
  return forwarded;
}
