const express = require('express');
const { logger } = require('@librechat/data-schemas');
const {
  saveArtifactCache,
  getArtifactCache,
  getArtifactCacheEntry,
  deleteArtifactCache,
  deleteAllUserArtifactCache,
  getConversationArtifactCache,
  cleanupExpiredArtifactCache,
} = require('~/models');
const { requireJwtAuth } = require('~/server/middleware');

const router = express.Router();

const artifactCachePayloadLimit = express.json({ limit: '1mb' });

router.use(requireJwtAuth);

/**
 * POST /artifact-cache
 * Creates or updates an artifact cache entry
 */
router.post('/', artifactCachePayloadLimit, async (req, res) => {
  try {
    const { artifactId, cacheType, data, conversationId, messageId, expiresAt } = req.body;
    const userId = req.user.id;

    if (!artifactId || !cacheType || !data) {
      return res.status(400).json({
        error: 'Missing required fields: artifactId, cacheType, data',
      });
    }

    if (!['selection', 'content', 'updateLocation'].includes(cacheType)) {
      return res.status(400).json({
        error: 'Invalid cacheType. Must be one of: selection, content, updateLocation',
      });
    }

    const entry = {
      userId,
      artifactId,
      cacheType,
      data,
      conversationId,
      messageId,
      expiresAt: expiresAt ? new Date(expiresAt) : undefined,
    };

    const result = await saveArtifactCache(entry);

    if (!result) {
      return res.status(500).json({
        error: 'Failed to save artifact cache entry',
      });
    }

    res.json({
      success: true,
      entry: result,
    });
  } catch (error) {
    logger.error('Error in POST /artifact-cache:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message,
    });
  }
});

/**
 * GET /artifact-cache/conversation/:conversationId
 * Retrieves all artifact cache entries for a specific conversation
 */
router.get('/conversation/:conversationId', async (req, res) => {
  try {
    const { conversationId } = req.params;
    const userId = req.user.id;

    const results = await getConversationArtifactCache(userId, conversationId);

    res.json({
      success: true,
      entries: results,
    });
  } catch (error) {
    logger.error('Error in GET /artifact-cache/conversation/:conversationId:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message,
    });
  }
});

/**
 * GET /artifact-cache/:artifactId
 * Retrieves artifact cache entries for a specific artifact
 */
router.get('/:artifactId', async (req, res) => {
  try {
    const { artifactId: encodedArtifactId } = req.params;
    const artifactId = decodeURIComponent(encodedArtifactId);
    const { cacheType } = req.query;
    const userId = req.user.id;
    console.log('artifactId', artifactId, 'cacheType', cacheType);
    const results = await getArtifactCache(userId, artifactId, cacheType);
    console.log('GET /artifact-cache/:artifactId results', results);
    res.json({
      success: true,
      entries: results,
    });
  } catch (error) {
    logger.error('Error in GET /artifact-cache/:artifactId:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message,
    });
  }
});

/**
 * GET /artifact-cache/:artifactId/:cacheType
 * Retrieves a specific artifact cache entry
 */
router.get('/:artifactId/:cacheType', async (req, res) => {
  try {
    const { artifactId: encodedArtifactId, cacheType } = req.params;
    const artifactId = decodeURIComponent(encodedArtifactId);
    const userId = req.user.id;

    if (!['selection', 'content', 'updateLocation'].includes(cacheType)) {
      return res.status(400).json({
        error: 'Invalid cacheType. Must be one of: selection, content, updateLocation',
      });
    }

    const result = await getArtifactCacheEntry(userId, artifactId, cacheType);

    res.json({
      success: true,
      entry: result,
    });
  } catch (error) {
    logger.error('Error in GET /artifact-cache/:artifactId/:cacheType:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message,
    });
  }
});

/**
 * DELETE /artifact-cache/:artifactId
 * Deletes artifact cache entries for a specific artifact
 */
router.delete('/:artifactId', async (req, res) => {
  try {
    const { artifactId: encodedArtifactId } = req.params;
    const artifactId = decodeURIComponent(encodedArtifactId);
    const { cacheType } = req.query;
    const userId = req.user.id;

    const deletedCount = await deleteArtifactCache(userId, artifactId, cacheType);

    res.json({
      success: true,
      deletedCount,
    });
  } catch (error) {
    logger.error('Error in DELETE /artifact-cache/:artifactId:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message,
    });
  }
});

/**
 * DELETE /artifact-cache
 * Deletes all artifact cache entries for the authenticated user
 */
router.delete('/', async (req, res) => {
  try {
    const userId = req.user.id;

    const deletedCount = await deleteAllUserArtifactCache(userId);

    res.json({
      success: true,
      deletedCount,
    });
  } catch (error) {
    logger.error('Error in DELETE /artifact-cache:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message,
    });
  }
});

/**
 * POST /artifact-cache/cleanup
 * Cleans up expired artifact cache entries (admin endpoint)
 */
router.post('/cleanup', async (req, res) => {
  try {
    // Note: In a production environment, you might want to add admin-only access control here
    const deletedCount = await cleanupExpiredArtifactCache();

    res.json({
      success: true,
      deletedCount,
    });
  } catch (error) {
    logger.error('Error in POST /artifact-cache/cleanup:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message,
    });
  }
});

module.exports = router;
