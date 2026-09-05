// Existing WASM bundles request this inventory during boot. No provider keys are stored.
export function GET() {
  return Response.json({ providers: [] });
}
