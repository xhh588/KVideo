/**
 * Parallel Streaming Search API Route
 * Searches all sources in parallel and streams results immediately as they arrive
 * No waiting - results flow in real-time
 */

import { NextRequest } from 'next/server';
import { searchVideos } from '@/lib/api/client';
import { getSourceById } from '@/lib/api/video-sources';
import { getSourceName } from '@/lib/utils/source-names';

export const runtime = 'edge';

// Stability: a single search must never be held hostage by the slowest
// source. 20s is the global deadline for the whole parallel search
// (per-source attempts are already capped in lib/api/http-utils.ts).
// After the deadline, in-flight source searches are abandoned and the
// stream completes with whatever arrived plus a per-source failure list.
const SEARCH_DEADLINE_MS = 20000;
// Auto-fetch at most 2 extra pages per source (pages 2-3). Previously
// every remaining page was fetched in parallel with no cap, so a source
// reporting pagecount=100 would fan out 99 concurrent requests.
const MAX_EXTRA_PAGES_PER_SOURCE = 2;

export async function POST(request: NextRequest) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      try {
        const body = await request.json();
        const { query, sources: sourceConfigs, page = 1 } = body;

        // Validate input
        if (!query || typeof query !== 'string' || query.trim().length === 0) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({
            type: 'error',
            message: 'Invalid query'
          })}\n\n`));
          controller.close();
          return;
        }

        // Use provided sources or fallback to empty (client should provide them)
        const sources = Array.isArray(sourceConfigs) && sourceConfigs.length > 0
          ? sourceConfigs
          : [];

        if (sources.length === 0) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({
            type: 'error',
            message: 'No valid sources provided'
          })}\n\n`));
          controller.close();
          return;
        }

        // Send initial status
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({
          type: 'start',
          totalSources: sources.length
        })}\n\n`));



        // Track progress
        let completedSources = 0;
        let totalVideosFound = 0;
        let maxPageCount = 1;
        // Sources that failed, surfaced in the final `complete` event so
        // the UI can show per-source status instead of a whole-page failure.
        const failedSources: Array<{ source: string; latency: number; error: string }> = [];
        const searchDeadline = Date.now() + SEARCH_DEADLINE_MS;
        const deadlineExceeded = () => Date.now() > searchDeadline;

        // Search all sources in PARALLEL - don't wait for all to finish
        const searchPromises = sources.map(async (source: any) => {
          const startTime = performance.now(); // Track start time
          try {
            if (deadlineExceeded()) throw new Error('Search deadline exceeded');

            // Search page 1 for this source
            const result = await searchVideos(query.trim(), [source], 1);
            const endTime = performance.now(); // Track end time
            const latency = Math.round(endTime - startTime); // Calculate latency in ms
            const videos = result[0]?.results || [];
            const pagecount = result[0]?.pagecount ?? 1;

            completedSources++;
            totalVideosFound += videos.length;

            // Stream page 1 videos immediately
            if (videos.length > 0) {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({
                type: 'videos',
                videos: videos.map((video: any) => ({
                  ...video,
                  sourceDisplayName: getSourceName(source.id),
                  latency,
                })),
                source: source.id,
                completedSources,
                totalSources: sources.length,
                latency,
              })}\n\n`));
            }

            // Send progress update for page 1
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({
              type: 'progress',
              completedSources,
              totalSources: sources.length,
              totalVideosFound
            })}\n\n`));

            // Auto-fetch remaining pages if pagecount > 1 (capped, see above)
            if (pagecount > 1 && !deadlineExceeded()) {
              const remainingPages = Array.from(
                { length: Math.min(pagecount - 1, MAX_EXTRA_PAGES_PER_SOURCE) },
                (_, i) => i + 2
              );
              const pagePromises = remainingPages.map(async (pg) => {
                try {
                  const pageResult = await searchVideos(query.trim(), [source], pg);
                  const pageVideos = pageResult[0]?.results || [];

                  totalVideosFound += pageVideos.length;

                  if (pageVideos.length > 0) {
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify({
                      type: 'videos',
                      videos: pageVideos.map((video: any) => ({
                        ...video,
                        sourceDisplayName: getSourceName(source.id),
                        latency,
                      })),
                      source: source.id,
                      completedSources,
                      totalSources: sources.length,
                      latency,
                    })}\n\n`));
                  }

                  // Progress update for each additional page
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify({
                    type: 'progress',
                    completedSources,
                    totalSources: sources.length,
                    totalVideosFound
                  })}\n\n`));

                } catch (pageError) {
                  console.error(`[Search Parallel] Source ${source.id} page ${pg} failed:`, pageError);
                }
              });

              await Promise.all(pagePromises);
            }

          } catch (error) {
            const endTime = performance.now();
            const latency = Math.round(endTime - startTime);
            // Log error but continue with other sources
            console.error(`[Search Parallel] Source ${source.id} failed after ${latency}ms:`, error);
            completedSources++;
            failedSources.push({
              source: source.id,
              latency,
              error: error instanceof Error ? error.message : 'Unknown error',
            });

            // Per-source failure event: the client can surface this as
            // "source X failed / skipped" instead of failing the search.
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({
              type: 'source_failed',
              source: source.id,
              latency,
              completedSources,
              totalSources: sources.length,
            })}\n\n`));

            controller.enqueue(encoder.encode(`data: ${JSON.stringify({
              type: 'progress',
              completedSources,
              totalSources: sources.length,
              totalVideosFound
            })}\n\n`));
          }
        });

        // Wait for all sources to complete
        await Promise.all(searchPromises);



        // Send completion signal
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({
          type: 'complete',
          totalVideosFound,
          totalSources: sources.length,
          maxPageCount,
          failedSources,
        })}\n\n`));

        controller.close();

      } catch (error) {
        console.error('Search error:', error);
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({
          type: 'error',
          message: error instanceof Error ? error.message : 'Unknown error'
        })}\n\n`));
        controller.close();
      }
    }
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}


