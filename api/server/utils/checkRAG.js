const { logger } = require('@librechat/data-schemas');

/**
 * Determines if a file upload should use RAG/vector database based on endpoint configuration
 * @param {Object} params
 * @param {ServerRequest} params.req - Express request object
 * @param {FileMetadata} params.metadata - File metadata containing endpoint, model, etc.
 * @param {AppConfig} params.appConfig - Application configuration
 * @returns {Promise<boolean>} - True if RAG should be used
 */
async function checkIfShouldUseRAG({ req, metadata, appConfig }) {
  // 1. Check if RAG_API_URL is configured
  if (!process.env.RAG_API_URL) {
    console.log('❌ [checkRAG] RAG_API_URL not configured, skipping RAG');
    logger.debug('[checkRAG] RAG_API_URL not configured, skipping RAG');
    return false;
  }

  // 2. Check if file exists and is not an image
  const file = req.file;
  if (!file) {
    console.log('❌ [checkRAG] No file provided');
    logger.debug('[checkRAG] No file provided');
    return false;
  }
  console.log('✅ [checkRAG] File provided:', file.originalname, '- Type:', file.mimetype);

  // Images typically use vision APIs, not RAG
  if (file.mimetype && file.mimetype.startsWith('image/')) {
    console.log('❌ [checkRAG] File is an image, skipping RAG');
    logger.debug('[checkRAG] File is an image, skipping RAG');
    return false;
  }

  // 3. Get endpoint and model from metadata
  let endpoint = metadata.endpoint;
  let endpointName = metadata.endpointName;
  const model = metadata.model;

  console.log('📋 [checkRAG] Metadata (raw):', {
    endpoint,
    model,
    endpointName,
    agent_id: metadata.agent_id,
    tool_resource: metadata.tool_resource,
  });

  // WORKAROUND: If endpointName is missing but endpoint looks like a custom endpoint name,
  // assume it's a custom endpoint and fix the metadata
  if (!endpointName && endpoint && endpoint !== 'custom' && !endpoint.includes('OpenAI')) {
    console.log(
      `🔧 [checkRAG] Fixing metadata: endpoint "${endpoint}" → endpoint "custom", endpointName "${endpoint}"`,
    );
    endpointName = endpoint;
    endpoint = 'custom';
  }

  if (!endpoint) {
    console.log('❌ [checkRAG] No endpoint specified in metadata');
    logger.debug('[checkRAG] No endpoint specified in metadata');
    return false;
  }

  console.log(`🔎 [checkRAG] Checking RAG for endpoint: "${endpoint}", model: "${model}"`);
  logger.debug(`[checkRAG] Checking RAG for endpoint: ${endpoint}, model: ${model}`);

  // 4. Check endpoint configuration
  const endpointConfig = appConfig.endpoints?.[endpoint];

  if (!endpointConfig) {
    console.log(`❌ [checkRAG] No configuration found for endpoint: ${endpoint}`);
    logger.debug(`[checkRAG] No configuration found for endpoint: ${endpoint}`);
    return false;
  }

  // 5. Handle custom endpoints (array of endpoint configs)
  if (Array.isArray(endpointConfig)) {
    if (!endpointName) {
      console.log('❌ [checkRAG] Custom endpoint but no endpointName in metadata');
      logger.debug('[checkRAG] Custom endpoint but no endpointName in metadata');
      return false;
    }

    // Find the matching custom endpoint configuration
    const matchingEndpoint = endpointConfig.find((e) => e.name === endpointName);

    if (!matchingEndpoint) {
      console.log(`❌ [checkRAG] No matching custom endpoint found: ${endpointName}`);
      logger.debug(`[checkRAG] No matching custom endpoint found: ${endpointName}`);
      return false;
    }

    console.log(`✅ [checkRAG] Found matching custom endpoint: "${endpointName}"`);
    console.log('   - retrieval enabled:', matchingEndpoint.retrieval);
    console.log('   - retrievalModels:', matchingEndpoint.retrievalModels);

    // Check if retrieval is enabled for this custom endpoint
    if (!matchingEndpoint.retrieval) {
      console.log(`❌ [checkRAG] Retrieval not enabled for custom endpoint: ${endpointName}`);
      logger.debug(`[checkRAG] Retrieval not enabled for custom endpoint: ${endpointName}`);
      return false;
    }

    // If no model specified, check if retrieval is enabled for the endpoint
    if (!model) {
      logger.debug(`[checkRAG] Retrieval enabled, no model specified - allowing RAG`);
      return true;
    }

    // Check if model is in retrievalModels list
    if (matchingEndpoint.retrievalModels && Array.isArray(matchingEndpoint.retrievalModels)) {
      const modelSupported = matchingEndpoint.retrievalModels.includes(model);
      console.log(
        `${modelSupported ? '✅' : '❌'} [checkRAG] Model "${model}" ${modelSupported ? 'IS' : 'IS NOT'} in retrievalModels list`,
      );
      console.log('   retrievalModels:', matchingEndpoint.retrievalModels);
      logger.debug(
        `[checkRAG] Model ${model} ${modelSupported ? 'IS' : 'IS NOT'} in retrievalModels list`,
      );
      return modelSupported;
    }

    // If retrieval: true but no retrievalModels list specified, allow all models
    console.log('✅ [checkRAG] Retrieval enabled, no retrievalModels list - allowing all models');
    logger.debug(`[checkRAG] Retrieval enabled, no retrievalModels list - allowing all models`);
    return true;
  }

  // 6. Handle built-in endpoints (azureOpenAI, assistants, etc.)
  if (!endpointConfig.retrieval) {
    console.log(`❌ [checkRAG] Retrieval not enabled for endpoint: ${endpoint}`);
    logger.debug(`[checkRAG] Retrieval not enabled for endpoint: ${endpoint}`);
    return false;
  }

  // Check if model is in retrievalModels list for built-in endpoints
  if (endpointConfig.retrievalModels && Array.isArray(endpointConfig.retrievalModels)) {
    const modelSupported = endpointConfig.retrievalModels.includes(model);
    console.log(
      `${modelSupported ? '✅' : '❌'} [checkRAG] Model "${model}" ${modelSupported ? 'IS' : 'IS NOT'} in retrievalModels list for ${endpoint}`,
    );
    logger.debug(
      `[checkRAG] Model ${model} ${modelSupported ? 'IS' : 'IS NOT'} in retrievalModels list for ${endpoint}`,
    );
    return modelSupported;
  }

  // If retrieval: true but no retrievalModels list, allow all models
  console.log(`✅ [checkRAG] Retrieval enabled for ${endpoint}, allowing all models`);
  logger.debug(`[checkRAG] Retrieval enabled for ${endpoint}, allowing all models`);
  return true;
}

module.exports = { checkIfShouldUseRAG };
