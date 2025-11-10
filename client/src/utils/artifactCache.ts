/**
 * A simple cache for artifact content to avoid redundant processing
 */
export const artifactUpdateCache = {
  _cache: new Map<string, string>(),

  /**
   * Set an artifact's content in the cache
   * @param id - The unique identifier for the artifact
   * @param content - The artifact content to cache
   */
  set(id: string, content: string): void {
    this._cache.set(id, content);
  },

  /**
   * Get an artifact's content from the cache
   * @param id - The unique identifier for the artifact
   * @returns The cached content or undefined if not in cache
   */
  get(id: string): string | undefined {
    return this._cache.get(id);
  },

  /**
   * Check if an artifact is in the cache
   * @param id - The unique identifier for the artifact
   * @returns Boolean indicating if the artifact is cached
   */
  has(id: string): boolean {
    return this._cache.has(id);
  },

  /**
   * Remove an artifact from the cache
   * @param id - The unique identifier for the artifact
   */
  delete(id: string): void {
    this._cache.delete(id);
  },

  /**
   * Clear the entire cache
   */
  clear(): void {
    this._cache.clear();
  },
};
