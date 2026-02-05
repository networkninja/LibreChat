import {
  parseConvo,
  EModelEndpoint,
  isAssistantsEndpoint,
  isAgentsEndpoint,
  LocalStorageKeys,
} from 'librechat-data-provider';
import type { TConversation, EndpointSchemaKey } from 'librechat-data-provider';
import { getLocalStorageItems } from './localStorage';

const buildDefaultConvo = ({
  models,
  conversation,
  endpoint = null,
  lastConversationSetup,
  index = 0,
}: {
  models: string[];
  conversation: TConversation;
  endpoint?: EModelEndpoint | null;
  lastConversationSetup: TConversation | null;
  index?: number;
}): TConversation => {
  const { lastSelectedModel, lastSelectedTools } = getLocalStorageItems();
  const endpointType = lastConversationSetup?.endpointType ?? conversation.endpointType;

  if (!endpoint) {
    return {
      ...conversation,
      endpointType,
      endpoint,
    };
  }

  const availableModels = models;
  const model = lastConversationSetup?.model ?? lastSelectedModel?.[endpoint] ?? '';
  const secondaryModel: string | null =
    endpoint === EModelEndpoint.gptPlugins
      ? (lastConversationSetup?.agentOptions?.model ?? lastSelectedModel?.secondaryModel ?? null)
      : null;

  let possibleModels: string[], secondaryModels: string[];
  const hasModelSpec = lastConversationSetup?.spec != null && lastConversationSetup.spec !== '';

  if (hasModelSpec && model) {
    // Model spec is active - prioritize its model
    possibleModels = [model, ...availableModels.filter((m) => m !== model)];
    console.log('🔍 [buildDefaultConvo] Using model spec model:', model);
  } else if (availableModels.includes(model)) {
    possibleModels = [model, ...availableModels];
  } else {
    possibleModels = [...availableModels];
  }

  if (secondaryModel != null && secondaryModel !== '' && availableModels.includes(secondaryModel)) {
    secondaryModels = [secondaryModel, ...availableModels];
  } else {
    secondaryModels = [...availableModels];
  }

  const convo = parseConvo({
    endpoint: endpoint as EndpointSchemaKey,
    endpointType: endpointType as EndpointSchemaKey,
    conversation: lastConversationSetup,
    possibleValues: {
      models: possibleModels,
      secondaryModels,
    },
  });

  const defaultConvo = {
    ...conversation,
    ...convo,
    endpointType,
    endpoint,
  };
  if (isAgentsEndpoint(endpoint) && lastConversationSetup?.model) {
    defaultConvo.model = lastConversationSetup.model;
  }

  // Ensures assistant_id is always defined
  const assistantId = convo?.assistant_id ?? conversation?.assistant_id ?? '';
  const defaultAssistantId = lastConversationSetup?.assistant_id ?? '';
  if (isAssistantsEndpoint(endpoint) && !defaultAssistantId && assistantId) {
    defaultConvo.assistant_id = assistantId;
  }

  // Ensures agent_id is always defined
  const lastSelectedAgentId =
    localStorage.getItem(`${LocalStorageKeys.AGENT_ID_PREFIX}${index}`) ?? '';
  const setupAgentId = lastConversationSetup?.agent_id ?? '';

  if (isAgentsEndpoint(endpoint)) {
    if (lastConversationSetup != null && 'agent_id' in lastConversationSetup) {
      defaultConvo.agent_id = setupAgentId;
    } else if (lastSelectedAgentId) {
      defaultConvo.agent_id = lastSelectedAgentId;
    } else {
      defaultConvo.agent_id = '';
    }
  }

  defaultConvo.tools = lastConversationSetup?.tools ?? lastSelectedTools ?? defaultConvo.tools;

  if (lastConversationSetup?.spec) {
    // Has a modelSpec - use it
    defaultConvo.spec = lastConversationSetup.spec;
  } else if (lastConversationSetup && 'spec' in lastConversationSetup) {
    defaultConvo.spec = '';
  } else {
    // No spec info in lastConversationSetup - fall back to localStorage for new conversations
    const lastSelectedSpec = localStorage.getItem(LocalStorageKeys.LAST_SPEC);
    defaultConvo.spec = lastSelectedSpec || '';
  }

  return defaultConvo;
};

export default buildDefaultConvo;
