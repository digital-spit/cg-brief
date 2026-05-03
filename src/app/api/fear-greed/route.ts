export const revalidate = 3600; // 1 hour — Alternative.me updates once daily

export async function GET() {
  try {
    const res = await fetch("https://api.alternative.me/fng/?limit=7", {
      next: { revalidate: 3600 },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return Response.json({
      current: data.data?.[0] ?? null,
      history: data.data ?? [],
      fetchedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("Fear & Greed fetch failed:", err);
    return Response.json({ current: null, history: [], error: "Failed to fetch" }, { status: 500 });
  }
}
