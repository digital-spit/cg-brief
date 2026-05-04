import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const ETORO_BASE = "https://public-api.etoro.com/api/v1";

function summarize(obj: unknown, depth = 0): unknown {
  if (obj == null) return obj;
  if (Array.isArray(obj)) {
    return {
      __type: "array",
      length: obj.length,
      sample: obj.length > 0 ? summarize(obj[0], depth + 1) : null,
    };
  }
  if (typeof obj === "object") {
    if (depth >= 3) return "[...]";
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      o[k] = summarize(v, depth + 1);
    }
    return o;
  }
  return typeof obj;
}

export async function GET(req: Request) {
  const apiKey = process.env.ETORO_API_KEY;
  const userKey = process.env.ETORO_USER_KEY;
  const url = new URL(req.url);
  const token = url.searchParams.get("k");

  // gate behind a shared secret to avoid leaking shape to public; reuse GITHUB-ish guard
  if (token !== "khaled-debug-2026") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  if (!apiKey || !userKey) {
    return NextResponse.json({ error: "no keys" }, { status: 500 });
  }

  const endpoints = [
    "/trading/info/portfolio",
    "/trading/info/portfolio/mirrors",
    "/trading/info/account-summary",
  ];

  const results: Record<string, unknown> = {};

  for (const path of endpoints) {
    try {
      const res = await fetch(`${ETORO_BASE}${path}`, {
        headers: {
          "Content-Type": "application/json",
          "x-api-key": userKey,
          "x-user-key": apiKey,
          "x-request-id": crypto.randomUUID(),
        },
        cache: "no-store",
      });
      if (!res.ok) {
        results[path] = { status: res.status, statusText: res.statusText };
        continue;
      }
      const data = await res.json();
      results[path] = {
        status: 200,
        topKeys: Object.keys(data ?? {}),
        shape: summarize(data),
      };
    } catch (err) {
      results[path] = { error: (err as Error).message };
    }
  }

  return NextResponse.json(results);
}
