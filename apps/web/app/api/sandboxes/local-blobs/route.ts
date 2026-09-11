import { serveLocalBlob } from "@/lib/blob-file";

export const runtime = "nodejs";
export const GET = serveLocalBlob;
export const PUT = serveLocalBlob;
