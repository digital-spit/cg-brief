import { fetchPortfolioNews } from "@/lib/news";
import { NextResponse } from "next/server";

export const revalidate = 0; // Always fresh — client decides caching

export async function GET() {
  try {
    const news = await fetchPortfolioNews();
    return NextResponse.json(
      { news, fetchedAt: Date.now() },
      {
        headers: {
          "Cache-Control": "public, s-maxage=1800, stale-while-revalidate=3600",
        },
      }
    );
  } catch {
    return NextResponse.json(
      { news: [], fetchedAt: Date.now(), error: "Failed to fetch news" },
      { status: 200 } // Return 200 so client shows empty state, not error
    );
  }
}
