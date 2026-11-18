import { useState, useEffect, useCallback } from 'react';
import { useInfiniteScroll } from '@/lib/hooks/useInfiniteScroll';

interface DoubanMovie {
    id: string;
    title: string;
    cover: string;
    rate: string;
    url: string;
}

const PAGE_LIMIT = 20;

// Same problem as the tags fetch: a plain fetch() to /api/douban/recommend
// has no timeout, so a stalled Douban call left the homepage grid on
// "加载中..." forever (loading only clears when the fetch settles).
// 8s is enough for a healthy 20-poster page; on timeout the grid shows
// "暂无内容" instead of spinning forever, and the user can retry by
// switching tags.
const RECOMMEND_FETCH_TIMEOUT_MS = 8000;

export function usePopularMovies(selectedTag: string, tags: any[], contentType: 'movie' | 'tv' = 'movie') {
    const [movies, setMovies] = useState<DoubanMovie[]>([]);
    const [loading, setLoading] = useState(false);
    const [hasMore, setHasMore] = useState(true);
    const [page, setPage] = useState(0);

    const loadMovies = useCallback(async (tag: string, pageStart: number, append = false) => {
        if (loading) return;

        setLoading(true);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), RECOMMEND_FETCH_TIMEOUT_MS);
        try {
            const tagValue = tags.find(t => t.id === tag)?.value || '热门';
            const response = await fetch(
                `/api/douban/recommend?type=${contentType}&tag=${encodeURIComponent(tagValue)}&page_limit=${PAGE_LIMIT}&page_start=${pageStart}`,
                { signal: controller.signal }
            );

            if (!response.ok) throw new Error('Failed to fetch');

            const data = await response.json();
            const newMovies = data.subjects || [];

            setMovies(prev => append ? [...prev, ...newMovies] : newMovies);
            setHasMore(newMovies.length === PAGE_LIMIT);
        } catch (error) {
            console.error('Failed to load movies:', error);
            setHasMore(false);
        } finally {
            clearTimeout(timer);
            setLoading(false);
        }
    }, [loading, tags, contentType]);

    useEffect(() => {
        setPage(0);
        setMovies([]);
        setHasMore(true);
        loadMovies(selectedTag, 0, false);
    }, [selectedTag, contentType]); // eslint-disable-line react-hooks/exhaustive-deps

    const { prefetchRef, loadMoreRef } = useInfiniteScroll({
        hasMore,
        loading,
        page,
        onLoadMore: (nextPage) => {
            setPage(nextPage);
            loadMovies(selectedTag, nextPage * PAGE_LIMIT, true);
        },
    });

    return {
        movies,
        loading,
        hasMore,
        prefetchRef,
        loadMoreRef,
    };
}
