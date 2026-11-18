import { useState, useEffect } from 'react';
import { DragEndEvent } from '@dnd-kit/core';
import { arrayMove } from '@dnd-kit/sortable';

const DEFAULT_TAG = { id: 'popular', label: '热门', value: '热门' };

// Small built-in fallback shown when the Douban tags API is slow or
// down. These are the standard Douban search tags, so they work as-is
// as `tag` values for /api/douban/recommend. The page must never sit
// on an empty tag row waiting for a network call that may never return.
const FALLBACK_TAGS = [
    DEFAULT_TAG,
    { id: 'tag_最新', label: '最新', value: '最新' },
    { id: 'tag_豆瓣高分', label: '豆瓣高分', value: '豆瓣高分' },
    { id: 'tag_经典', label: '经典', value: '经典' },
    { id: 'tag_华语', label: '华语', value: '华语' },
    { id: 'tag_欧美', label: '欧美', value: '欧美' },
];

// Homepage fetches must never hang forever: the Douban API is slow /
// rate-limited from some networks, and a plain fetch() has no timeout
// (a stalled connection can hang for minutes). 5s is enough for a
// healthy tags call; after that we fall back and clear the spinner.
const TAGS_FETCH_TIMEOUT_MS = 5000;

async function fetchTagsWithTimeout(contentType: 'movie' | 'tv') {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TAGS_FETCH_TIMEOUT_MS);
    try {
        const response = await fetch(`/api/douban/tags?type=${contentType}`, {
            signal: controller.signal,
        });
        const data = await response.json();
        return data;
    } finally {
        clearTimeout(timer);
    }
}

const STORAGE_KEY_PREFIX = 'kvideo_custom_tags_';

export function useTagManager() {
    const [contentType, setContentType] = useState<'movie' | 'tv'>(() => {
        if (typeof window === 'undefined') return 'movie';
        const saved = localStorage.getItem('kvideo_default_content_type');
        return saved === 'tv' ? 'tv' : 'movie';
    });
    const [selectedTag, setSelectedTag] = useState(DEFAULT_TAG.value);
    // Start with the fallback list so the tag row renders immediately;
    // the live Douban list replaces it when (and if) it arrives.
    const [tags, setTags] = useState<any[]>(FALLBACK_TAGS);
    const [isLoadingTags, setIsLoadingTags] = useState(false);
    const [newTagInput, setNewTagInput] = useState('');
    const [showTagManager, setShowTagManager] = useState(false);
    const [justAddedTag, setJustAddedTag] = useState(false);

    // Persist content type preference
    useEffect(() => {
        localStorage.setItem('kvideo_default_content_type', contentType);
    }, [contentType]);

    const storageKey = `${STORAGE_KEY_PREFIX}${contentType}`;

    // Load custom tags or fetch from Douban
    useEffect(() => {
        const loadTags = async () => {
            const saved = localStorage.getItem(storageKey);
            if (saved) {
                try {
                    setTags(JSON.parse(saved));
                    return;
                } catch (e) {
                    console.error('Failed to parse saved tags', e);
                }
            }

            // If no saved tags, fetch from Douban (with a hard timeout:
            // without one, a stalled Douban call left the homepage on
            // "正在加载标签..." forever and the grid never rendered).
            setIsLoadingTags(true);
            try {
                const data = await fetchTagsWithTimeout(contentType);
                if (data.tags && Array.isArray(data.tags) && data.tags.length > 0) {
                    const mappedTags = data.tags.map((label: string) => ({
                        id: label === '热门' ? 'popular' : `tag_${label}`,
                        label,
                        value: label,
                    }));

                    // If "热门" isn't in the list, add it to the front
                    if (!mappedTags.some((t: any) => t.value === '热门')) {
                        mappedTags.unshift(DEFAULT_TAG);
                    }

                    setTags(mappedTags);
                    // Also save to localStorage to avoid repeated fetches if desired
                    // Actually, let's just keep them in memory for now unless they customize
                } else {
                    // Empty list (e.g. API 500 with { tags: [] }): keep the
                    // fallback instead of an empty tag row.
                    setTags(FALLBACK_TAGS);
                }
            } catch (error) {
                console.error('Fetch tags error:', error);
                setTags(FALLBACK_TAGS);
            } finally {
                setIsLoadingTags(false);
            }
        };

        loadTags();
        setSelectedTag(DEFAULT_TAG.value);
    }, [contentType, storageKey]);

    const saveTags = (newTags: any[]) => {
        setTags(newTags);
        localStorage.setItem(storageKey, JSON.stringify(newTags));
    };

    const handleAddTag = () => {
        if (!newTagInput.trim()) return;
        const newTag = {
            id: `custom_${Date.now()}`,
            label: newTagInput.trim(),
            value: newTagInput.trim(),
        };
        saveTags([...tags, newTag]);
        setNewTagInput('');
        setJustAddedTag(true);
    };

    const handleDeleteTag = (tagId: string) => {
        saveTags(tags.filter(t => t.id !== tagId));
        if (selectedTag === tagId) {
            setSelectedTag('popular');
        }
    };

    const handleRestoreDefaults = async () => {
        localStorage.removeItem(storageKey);
        // Refresh by re-fetching (same 5s timeout as the initial load)
        setIsLoadingTags(true);
        try {
            const data = await fetchTagsWithTimeout(contentType);
            if (data.tags && Array.isArray(data.tags) && data.tags.length > 0) {
                const mappedTags = data.tags.map((label: string) => ({
                    id: label === '热门' ? 'popular' : `tag_${label}`,
                    label,
                    value: label,
                }));
                if (!mappedTags.some((t: any) => t.value === '热门')) {
                    mappedTags.unshift(DEFAULT_TAG);
                }
                setTags(mappedTags);
            } else {
                setTags(FALLBACK_TAGS);
            }
        } catch (error) {
            setTags(FALLBACK_TAGS);
        } finally {
            setIsLoadingTags(false);
        }
        setSelectedTag(DEFAULT_TAG.value);
        setShowTagManager(false);
    };

    const handleDragEnd = (event: DragEndEvent) => {
        const { active, over } = event;

        if (over && active.id !== over.id) {
            const oldIndex = tags.findIndex((tag) => tag.id === active.id);
            const newIndex = tags.findIndex((tag) => tag.id === over.id);
            saveTags(arrayMove(tags, oldIndex, newIndex));
        }
    };

    return {
        tags,
        selectedTag,
        contentType,
        newTagInput,
        showTagManager,
        justAddedTag,
        isLoadingTags,
        setContentType,
        setSelectedTag,
        setNewTagInput,
        setShowTagManager,
        setJustAddedTag,
        handleAddTag,
        handleDeleteTag,
        handleRestoreDefaults,
        handleDragEnd,
    };
}
