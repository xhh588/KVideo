/**
 * useLatencyPing - Hook for real-time latency measurement
 * Periodically pings video sources when enabled
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { settingsStore } from '@/lib/store/settings-store';

interface LatencyState {
    [sourceId: string]: number;
}

interface UseLatencyPingOptions {
    sourceUrls: { id: string; baseUrl: string }[];
    enabled?: boolean;
    intervalMs?: number;
}

export function useLatencyPing({
    sourceUrls,
    enabled = true,
    // 30s, up from 5s: pinging every source every 5s kept the radio
    // awake and fired a full round of /api/ping requests on every
    // mobile screen. Latency badges do not need 5s freshness.
    intervalMs = 30000,
}: UseLatencyPingOptions) {
    const [latencies, setLatencies] = useState<LatencyState>({});
    const [isLoading, setIsLoading] = useState(false);
    const intervalRef = useRef<NodeJS.Timeout | null>(null);
    const mountedRef = useRef(true);

    // Check if real-time latency is enabled in settings
    const [realtimeEnabled, setRealtimeEnabled] = useState(false);

    // Stabilize sourceUrls to prevent unnecessary effect re-runs if parent passes new array
    const stableSourceUrls = useMemo(() => sourceUrls, [
        // Create a unique key for the sources array
        sourceUrls.map(s => `${s.id}|${s.baseUrl}`).join(',')
    ]);

    useEffect(() => {
        const settings = settingsStore.getSettings();
        setRealtimeEnabled(settings.realtimeLatency);

        // Subscribe to settings changes
        const unsubscribe = settingsStore.subscribe(() => {
            const newSettings = settingsStore.getSettings();
            setRealtimeEnabled(newSettings.realtimeLatency);
        });

        return () => {
            unsubscribe();
        };
    }, []);

    const pingSource = useCallback(async (sourceId: string, baseUrl: string): Promise<number | null> => {
        try {
            const response = await fetch('/api/ping', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: baseUrl }),
            });

            if (response.ok) {
                const data = await response.json();
                return data.latency || null;
            }
            return null;
        } catch {
            return null;
        }
    }, []);

    const pingAllSources = useCallback(async () => {
        if (!mountedRef.current || stableSourceUrls.length === 0) return;
        // Do not ping while the tab is hidden (Fold7 background / screen
        // off): the results are invisible and the radio stays awake.
        if (typeof document !== 'undefined' && document.hidden) return;

        setIsLoading(true);

        // Batch pings 3 at a time instead of firing all sources at
        // once; with 20+ sources the old Promise.all burst could
        // saturate a mobile connection and time out most of them.
        const results: Array<{ id: string; latency: number | null }> = [];
        for (let i = 0; i < stableSourceUrls.length; i += 3) {
            if (!mountedRef.current) break;
            const batch = stableSourceUrls.slice(i, i + 3);
            const batchResults = await Promise.all(
                batch.map(async ({ id, baseUrl }) => {
                    const latency = await pingSource(id, baseUrl);
                    return { id, latency };
                })
            );
            results.push(...batchResults);
        }

        if (mountedRef.current) {
            setLatencies(prev => {
                const newState = { ...prev };
                results.forEach(({ id, latency }) => {
                    if (latency !== null) {
                        newState[id] = latency;
                    }
                });
                return newState;
            });
            setIsLoading(false);
        }
    }, [stableSourceUrls, pingSource]);

    // Start/stop polling based on enabled state
    useEffect(() => {
        mountedRef.current = true;

        const shouldPoll = enabled && realtimeEnabled && stableSourceUrls.length > 0;

        if (shouldPoll) {
            // Initial ping
            pingAllSources();

            // Set up interval
            intervalRef.current = setInterval(pingAllSources, intervalMs);
        }

        return () => {
            mountedRef.current = false;
            if (intervalRef.current) {
                clearInterval(intervalRef.current);
                intervalRef.current = null;
            }
        };
    }, [enabled, realtimeEnabled, stableSourceUrls, intervalMs, pingAllSources]);

    const refreshLatency = useCallback((sourceId: string) => {
        const source = stableSourceUrls.find(s => s.id === sourceId);
        if (source) {
            pingSource(sourceId, source.baseUrl).then(latency => {
                if (latency !== null && mountedRef.current) {
                    setLatencies(prev => ({ ...prev, [sourceId]: latency }));
                }
            });
        }
    }, [stableSourceUrls, pingSource]);

    const refreshAll = useCallback(() => {
        pingAllSources();
    }, [pingAllSources]);

    return {
        latencies,
        isLoading,
        refreshLatency,
        refreshAll,
        isRealtimeEnabled: realtimeEnabled,
    };
}
