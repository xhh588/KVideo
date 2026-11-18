import { Video } from '@/lib/types';
import { getSourceName } from '@/lib/utils/source-names';
import { calculateRelevanceScore, hasMinimumMatch } from '@/lib/utils/search';

interface StreamHandlerParams {
    reader: ReadableStreamDefaultReader<Uint8Array>;
    onStart: (totalSources: number) => void;
    onVideos: (videos: Video[], source: string) => void;
    onProgress: (completedSources: number, totalVideosFound: number) => void;
    onComplete: () => void;
    onError: (message: string) => void;
    onPageInfo?: (maxPageCount: number) => void;
    onSourceFailed?: (source: string, latency: number) => void;
    currentQuery: string;
}

export async function processSearchStream({
    reader,
    onStart,
    onVideos,
    onProgress,
    onComplete,
    onError,
    onPageInfo,
    onSourceFailed,
    currentQuery,
}: StreamHandlerParams) {
    const decoder = new TextDecoder();
    let buffer = '';
    let timeoutId: NodeJS.Timeout | null = null;
    let isCompleted = false;

    // Auto-complete if no progress for 8 seconds. Previously 3s: on a
    // slow mobile network a source that pauses >3s between SSE chunks
    // would end the whole search early and drop its results. 8s still
    // bounds a stalled stream (the server also has a 20s deadline).
    const STREAM_IDLE_TIMEOUT_MS = 8000;
    const resetTimeout = () => {
        if (timeoutId) clearTimeout(timeoutId);

        timeoutId = setTimeout(() => {
            if (!isCompleted) {

                isCompleted = true;
                onComplete();
            }
        }, STREAM_IDLE_TIMEOUT_MS);
    };

    try {
        resetTimeout(); // Start initial timeout

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;

                try {
                    const data = JSON.parse(line.slice(6));

                    if (data.type === 'start') {
                        onStart(data.totalSources);
                        resetTimeout();
                    } else if (data.type === 'videos') {
                        const newVideos: Video[] = data.videos
                            .filter((video: any) => hasMinimumMatch(video.vod_name, currentQuery))
                            .map((video: any) => ({
                                ...video,
                                sourceName: video.sourceDisplayName || getSourceName(video.source),
                                isNew: true,
                                relevanceScore: calculateRelevanceScore(video, currentQuery),
                            }));
                        onVideos(newVideos, data.source);
                        if (data.pagecount && onPageInfo) {
                            onPageInfo(data.pagecount);
                        }
                        resetTimeout();
                    } else if (data.type === 'progress') {
                        onProgress(data.completedSources, data.totalVideosFound);
                        resetTimeout();
                    } else if (data.type === 'complete') {
                        if (timeoutId) clearTimeout(timeoutId);
                        isCompleted = true;
                        if (data.maxPageCount && onPageInfo) {
                            onPageInfo(data.maxPageCount);
                        }
                        onComplete();
                    } else if (data.type === 'source_failed') {
                        // A single source died; the search as a whole
                        // continues. Keep the stream alive and let the
                        // caller record the failure (progress already
                        // counts it as completed on the server).
                        if (onSourceFailed && data.source) {
                            onSourceFailed(data.source, data.latency ?? 0);
                        }
                        resetTimeout();
                    } else if (data.type === 'error') {
                        onError(data.message);
                    }
                } catch (error) {
                    console.error('Error parsing stream data:', error);
                }
            }
        }
    } catch (error) {
        if (timeoutId) clearTimeout(timeoutId);
        // A user-cancelled search aborts the reader: that is not an
        // error, the new search (if any) owns the UI state now.
        if (error instanceof Error && error.name === 'AbortError') return;
        throw error;
    } finally {
        if (timeoutId) clearTimeout(timeoutId);
    }
}
