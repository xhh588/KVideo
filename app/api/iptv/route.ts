/**
 * IPTV Proxy API Route
 * Fetches M3U playlist files to avoid CORS issues
 */

import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'edge';

export async function GET(request: NextRequest) {
  const url = request.nextUrl.searchParams.get('url');

  if (!url) {
    return NextResponse.json({ error: 'Missing url parameter' }, { status: 400 });
  }

  try {
    // No timeout previously: a hung playlist URL blocked this route
    // indefinitely. 10s, returning 504 on timeout so callers can
    // fall back to the next IPTV source instead of hanging.
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    let response: Response;
    try {
        response = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; KVideo/1.0)',
            },
            signal: controller.signal,
        });
    } catch (error) {
        clearTimeout(timeoutId);
        if (error instanceof Error && error.name === 'AbortError') {
            return NextResponse.json(
                { error: 'IPTV source timed out after 10s' },
                { status: 504 }
            );
        }
        throw error;
    }
    clearTimeout(timeoutId);

    if (!response.ok) {
      return NextResponse.json(
        { error: `Failed to fetch: ${response.status}` },
        { status: response.status }
      );
    }

    const text = await response.text();

    return new NextResponse(text, {
      status: 200,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=300', // Cache for 5 minutes
      },
    });
  } catch (e) {
    return NextResponse.json(
      { error: 'Failed to fetch M3U playlist' },
      { status: 500 }
    );
  }
}
