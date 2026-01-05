const mongoose = require('mongoose');

const artifactCacheSchema = mongoose.Schema(
  {
    userId: {
      type: String,
      required: true,
      index: true,
    },
    artifactId: {
      type: String,
      required: true,
      index: true,
    },
    conversationId: {
      type: String,
      index: true,
    },
    messageId: {
      type: String,
      index: true,
    },
    cacheType: {
      type: String,
      required: true,
      enum: ['selection', 'content', 'updateLocation'],
      index: true,
    },
    data: {
      type: mongoose.Schema.Types.Mixed,
      required: true,
    },
    expiresAt: {
      type: Date,
      index: true,
    },
  },
  { timestamps: true },
);

// Compound index for efficient queries
artifactCacheSchema.index({ userId: 1, artifactId: 1, cacheType: 1 });
artifactCacheSchema.index({ userId: 1, conversationId: 1 });

// TTL index - automatically delete expired entries
artifactCacheSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

/**
 * Saves or updates an artifact cache entry
 * @param {Object} entry - The cache entry to save
 * @returns {Promise<Object>} The saved entry
 */
const saveArtifactCache = async (entry) => {
  const { userId, artifactId, cacheType, data, conversationId, messageId, expiresAt } = entry;

  console.log('💾💾💾 [ArtifactCache.saveArtifactCache] Saving to database:', {
    userId,
    artifactId,
    cacheType,
    conversationId,
    messageId,
    hasConversationId: !!conversationId,
    dataKeys: data ? Object.keys(data) : [],
  });

  // Use findOneAndUpdate with upsert to create or update
  const result = await ArtifactCache.findOneAndUpdate(
    { userId, artifactId, cacheType },
    {
      userId,
      artifactId,
      cacheType,
      data,
      conversationId,
      messageId,
      expiresAt,
    },
    {
      upsert: true,
      new: true,
      runValidators: true,
    },
  );

  console.log('✅ [ArtifactCache.saveArtifactCache] Saved successfully:', {
    _id: result._id,
    userId: result.userId,
    artifactId: result.artifactId,
    cacheType: result.cacheType,
    conversationId: result.conversationId,
    savedConversationId: result.conversationId || 'NOT SAVED!',
  });

  return result;
};

/**
 * Retrieves artifact cache entries for a specific artifact
 * @param {string} userId - The user ID
 * @param {string} artifactId - The artifact ID
 * @param {string} [cacheType] - Optional cache type filter
 * @returns {Promise<Array>} Array of cache entries
 */
const getArtifactCache = async (userId, artifactId, cacheType) => {
  const query = { userId, artifactId };
  if (cacheType) {
    query.cacheType = cacheType;
  }

  const results = await ArtifactCache.find(query).sort({ updatedAt: -1 });

  console.log('🔍 [ArtifactCache.getArtifactCache] Query results:', {
    userId,
    artifactId,
    cacheType,
    resultsCount: results.length,
  });

  return results;
};

/**
 * Retrieves a specific artifact cache entry
 * @param {string} userId - The user ID
 * @param {string} artifactId - The artifact ID
 * @param {string} cacheType - The cache type
 * @returns {Promise<Object|null>} The cache entry or null
 */
const getArtifactCacheEntry = async (userId, artifactId, cacheType) => {
  const result = await ArtifactCache.findOne({ userId, artifactId, cacheType });
  return result;
};

/**
 * Deletes artifact cache entries
 * @param {string} userId - The user ID
 * @param {string} artifactId - The artifact ID
 * @param {string} [cacheType] - Optional cache type filter
 * @returns {Promise<number>} Number of deleted entries
 */
const deleteArtifactCache = async (userId, artifactId, cacheType) => {
  const query = { userId, artifactId };
  if (cacheType) {
    query.cacheType = cacheType;
  }

  const result = await ArtifactCache.deleteMany(query);
  return result.deletedCount;
};

/**
 * Deletes all artifact cache entries for a user
 * @param {string} userId - The user ID
 * @returns {Promise<number>} Number of deleted entries
 */
const deleteAllUserArtifactCache = async (userId) => {
  const result = await ArtifactCache.deleteMany({ userId });
  return result.deletedCount;
};

/**
 * Retrieves all artifact cache entries for a conversation
 * @param {string} userId - The user ID
 * @param {string} conversationId - The conversation ID
 * @returns {Promise<Array>} Array of cache entries
 */
const getConversationArtifactCache = async (userId, conversationId) => {
  console.log('🔍 [ArtifactCache.getConversationArtifactCache] Querying database:', {
    userId,
    conversationId,
  });

  const results = await ArtifactCache.find({ userId, conversationId }).sort({ updatedAt: -1 });

  console.log('📦 [ArtifactCache.getConversationArtifactCache] Query results:', {
    userId,
    conversationId,
    resultsCount: results.length,
    resultTypes: results.map((r) => r.cacheType),
    artifactIds: results.map((r) => r.artifactId),
  });

  return results;
};

/**
 * Cleans up expired artifact cache entries
 * @returns {Promise<number>} Number of deleted entries
 */
const cleanupExpiredArtifactCache = async () => {
  const now = new Date();
  const result = await ArtifactCache.deleteMany({
    expiresAt: { $lte: now },
  });
  return result.deletedCount;
};

// Check if model already exists before compiling
// This prevents "OverwriteModelError" during hot-reloads in development
const ArtifactCache =
  mongoose.models.ArtifactCache || mongoose.model('ArtifactCache', artifactCacheSchema);

module.exports = {
  ArtifactCache,
  saveArtifactCache,
  getArtifactCache,
  getArtifactCacheEntry,
  deleteArtifactCache,
  deleteAllUserArtifactCache,
  getConversationArtifactCache,
  cleanupExpiredArtifactCache,
};
