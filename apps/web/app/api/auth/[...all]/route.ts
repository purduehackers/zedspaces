import { login } from "@/lib/login";
export const runtime = "nodejs";
export async function GET(req: Request) { return (await login()).handler(req); }
export async function POST(req: Request) { return (await login()).handler(req); }
