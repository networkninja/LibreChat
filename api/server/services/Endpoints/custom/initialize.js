const {
  CacheKeys,
  ErrorTypes,
  envVarRegex,
  FetchTokenConfig,
  extractEnvVariable,
} = require('librechat-data-provider');
const { Providers } = require('@librechat/agents');
const { getOpenAIConfig, createHandleLLMNewToken, resolveHeaders } = require('@librechat/api');
const { getUserKeyValues, checkUserKeyExpiry } = require('~/server/services/UserService');
const { getCustomEndpointConfig } = require('~/server/services/Config');
const { fetchModels } = require('~/server/services/ModelService');
const OpenAIClient = require('~/app/clients/OpenAIClient');
const { isUserProvided } = require('~/server/utils');
const getLogStores = require('~/cache/getLogStores');

//use to list all the models, easy to update with new models
const thinkingModels = [
  'claude-3.7-sonnet',
  'claude-3-7-sonnet-latest',
  'claude-4-sonnet',
  'claude-4-opus',
  'anthropic-claude-3-7-sonnet',
  'anthropic-claude-4-sonnet',
  'anthropic-claude-4-opus',
  'groq-deepseek-r1-distill-llama-70b',
];

const { PROXY } = process.env;

const initializeClient = async ({ req, res, endpointOption, optionsOnly, overrideEndpoint }) => {
  const { key: expiresAt } = req.body;
  const endpoint = overrideEndpoint ?? req.body.endpoint;

  const endpointConfig = await getCustomEndpointConfig(endpoint);
  if (!endpointConfig) {
    throw new Error(`Config not found for the ${endpoint} custom endpoint.`);
  }

  const CUSTOM_API_KEY = extractEnvVariable(endpointConfig.apiKey);
  const CUSTOM_BASE_URL = extractEnvVariable(endpointConfig.baseURL);

  let resolvedHeaders = resolveHeaders(endpointConfig.headers, req.user);

  if (CUSTOM_API_KEY.match(envVarRegex)) {
    throw new Error(`Missing API Key for ${endpoint}.`);
  }

  if (CUSTOM_BASE_URL.match(envVarRegex)) {
    throw new Error(`Missing Base URL for ${endpoint}.`);
  }

  const userProvidesKey = isUserProvided(CUSTOM_API_KEY);
  const userProvidesURL = isUserProvided(CUSTOM_BASE_URL);

  let userValues = null;
  if (expiresAt && (userProvidesKey || userProvidesURL)) {
    checkUserKeyExpiry(expiresAt, endpoint);
    userValues = await getUserKeyValues({ userId: req.user.id, name: endpoint });
  }

  let apiKey = userProvidesKey ? userValues?.apiKey : CUSTOM_API_KEY;
  let baseURL = userProvidesURL ? userValues?.baseURL : CUSTOM_BASE_URL;

  if (userProvidesKey & !apiKey) {
    throw new Error(
      JSON.stringify({
        type: ErrorTypes.NO_USER_KEY,
      }),
    );
  }

  if (userProvidesURL && !baseURL) {
    throw new Error(
      JSON.stringify({
        type: ErrorTypes.NO_BASE_URL,
      }),
    );
  }

  if (!apiKey) {
    throw new Error(`${endpoint} API key not provided.`);
  }

  if (!baseURL) {
    throw new Error(`${endpoint} Base URL not provided.`);
  }

  const cache = getLogStores(CacheKeys.TOKEN_CONFIG);
  const tokenKey =
    !endpointConfig.tokenConfig && (userProvidesKey || userProvidesURL)
      ? `${endpoint}:${req.user.id}`
      : endpoint;

  let endpointTokenConfig =
    !endpointConfig.tokenConfig &&
    FetchTokenConfig[endpoint.toLowerCase()] &&
    (await cache.get(tokenKey));

  if (
    FetchTokenConfig[endpoint.toLowerCase()] &&
    endpointConfig &&
    endpointConfig.models.fetch &&
    !endpointTokenConfig
  ) {
    await fetchModels({ apiKey, baseURL, name: endpoint, user: req.user.id, tokenKey });
    endpointTokenConfig = await cache.get(tokenKey);
  }

  if (!endpointConfig.addParams) {
    endpointConfig.addParams = {};
  }

  if (endpointOption.model_parameters?.reasoning_effort) {
    // console.log("reasoning_Effort custom")
    endpointConfig.addParams.reasoning_effort =
      endpointOption.model_parameters?.reasoning_effort ?? endpointConfig?.reasoning_effort;
    endpointConfig.addParams.thinking = {
      type: 'enabled',
      budget_tokens: endpointOption.model_parameters?.thinkingBudget ?? 2000,
    };
    delete endpointOption.model_parameters.temperature;
  } else if (endpointOption.model_parameters?.thinking) {
    // console.log("thinking set", endpointOption.model_parameters?.thinking)
    endpointConfig.addParams.thinking = {
      type: endpointOption.model_parameters?.thinking ? 'enabled' : 'disabled',
      budget_tokens: endpointOption.model_parameters?.thinkingBudget ?? 2000,
    };
    // if(endpointOption.model_parameters?.thinking){
      endpointConfig.addParams.reasoning = {
        effort: endpointOption.model_parameters?.reasoning_effort
          ? endpointConfig?.reasoning
          : 'medium',
      };
    //}
    delete endpointOption.model_parameters.temperature;
  } else if (
    thinkingModels.includes(req.body.model) &&
    endpointOption.model_parameters?.thinking != false &&
    req.body?.thinking != false
  ) {
    // console.log("thinking model", req.body)
    endpointConfig.addParams.thinking = {
      type: 'enabled',
      budget_tokens: endpointOption.model_parameters?.thinkingBudget ?? 2000,
    };
    endpointConfig.addParams.reasoning = {
      effort: endpointOption.model_parameters?.reasoning_effort
        ? endpointConfig?.reasoning
        : 'medium',
    };
    delete endpointOption.model_parameters.temperature;
  }
  endpointConfig.addParams.reasoning = {
    effort: endpointOption.model_parameters?.reasoning_effort
      ? endpointConfig?.reasoning
      : 'medium',
  };

  // console.log(
  //   'endpointOption.model_parameters.model',
  //   endpointOption.model_parameters.model,
  //   req.body,
  // );

  const customOptions = {
    headers: resolvedHeaders,
    addParams: endpointConfig.addParams,
    dropParams: endpointConfig.dropParams,
    customParams: endpointConfig.customParams,
    titleConvo: endpointConfig.titleConvo,
    titleModel: endpointConfig.titleModel,
    forcePrompt: endpointConfig.forcePrompt,
    summaryModel: endpointConfig.summaryModel,
    modelDisplayLabel: endpointConfig.modelDisplayLabel,
    titleMethod: endpointConfig.titleMethod ?? 'completion',
    contextStrategy: endpointConfig.summarize ? 'summarize' : null,
    directEndpoint: endpointConfig.directEndpoint,
    titleMessageRole: endpointConfig.titleMessageRole,
    streamRate: endpointConfig.streamRate,
    endpointTokenConfig,
  };

  /** @type {undefined | TBaseEndpoint} */
  const allConfig = req.app.locals.all;
  if (allConfig) {
    customOptions.streamRate = allConfig.streamRate;
  }

  let clientOptions = {
    reverseProxyUrl: baseURL ?? null,
    proxy: PROXY ?? null,
    req,
    res,
    ...customOptions,
    ...endpointOption,
  };

  if (optionsOnly) {
    const modelOptions = endpointOption?.model_parameters ?? {};
    if (endpoint !== Providers.OLLAMA) {
      clientOptions = Object.assign(
        {
          modelOptions,
        },
        clientOptions,
      );
      clientOptions.modelOptions.user = req.user.id;
      const options = getOpenAIConfig(apiKey, clientOptions, endpoint);
      if (options != null) {
        options.useLegacyContent = true;
        options.endpointTokenConfig = endpointTokenConfig;
      }
      if (!clientOptions.streamRate) {
        return options;
      }
      options.llmConfig.callbacks = [
        {
          handleLLMNewToken: createHandleLLMNewToken(clientOptions.streamRate),
        },
      ];
      return options;
    }

    if (clientOptions.reverseProxyUrl) {
      modelOptions.baseUrl = clientOptions.reverseProxyUrl.split('/v1')[0];
      delete clientOptions.reverseProxyUrl;
    }

    return {
      useLegacyContent: true,
      llmConfig: modelOptions,
    };
  }

  const client = new OpenAIClient(apiKey, clientOptions);
  return {
    client,
    openAIApiKey: apiKey,
  };
};

module.exports = initializeClient;
