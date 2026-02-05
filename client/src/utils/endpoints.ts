import {
  Constants,
  EModelEndpoint,
  defaultEndpoints,
  modularEndpoints,
  LocalStorageKeys,
  getEndpointField,
  isAgentsEndpoint,
  isAssistantsEndpoint,
  PermissionTypes,
} from 'librechat-data-provider';
import type * as t from 'librechat-data-provider';
import type { LocalizeFunction, IconsRecord } from '~/common';

export const getEntityName = ({
  name = '',
  localize,
  isAgent,
}: {
  name?: string;
  isAgent?: boolean;
  localize: LocalizeFunction;
}) => {
  if (name && name.length > 0) {
    return name;
  } else {
    return isAgent === true ? localize('com_ui_agent') : localize('com_ui_assistant');
  }
};

export const getEndpointsFilter = (endpointsConfig: t.TEndpointsConfig) => {
  const filter: Record<string, boolean> = {};
  if (!endpointsConfig) {
    return filter;
  }
  for (const key of Object.keys(endpointsConfig)) {
    filter[key] = !!endpointsConfig[key];
  }
  return filter;
};

export const getAvailableEndpoints = (
  filter: Record<string, boolean>,
  endpointsConfig: t.TEndpointsConfig,
) => {
  const defaultSet = new Set(defaultEndpoints);
  const availableEndpoints: EModelEndpoint[] = [];

  for (const endpoint in endpointsConfig) {
    // Check if endpoint is in the filter or its type is in defaultEndpoints
    if (
      filter[endpoint] ||
      (endpointsConfig[endpoint]?.type &&
        defaultSet.has(endpointsConfig[endpoint]?.type as EModelEndpoint))
    ) {
      availableEndpoints.push(endpoint as EModelEndpoint);
    }
  }

  return availableEndpoints;
};

export function mapEndpoints(endpointsConfig: t.TEndpointsConfig) {
  const filter = getEndpointsFilter(endpointsConfig);
  return getAvailableEndpoints(filter, endpointsConfig).sort(
    (a, b) => (endpointsConfig?.[a]?.order ?? 0) - (endpointsConfig?.[b]?.order ?? 0),
  );
}

const firstLocalConvoKey = LocalStorageKeys.LAST_CONVO_SETUP + '_0';

/**
 * Ensures the last selected model stays up to date, as conversation may
 * update without updating last convo setup when same endpoint */
export function updateLastSelectedModel({
  endpoint,
  model = '',
}: {
  endpoint: string;
  model?: string;
}) {
  if (!model) {
    return;
  }
  /* Note: an empty string value is possible */
  const lastConversationSetup = JSON.parse(
    (localStorage.getItem(firstLocalConvoKey) ?? '{}') || '{}',
  );

  if (lastConversationSetup.endpoint === endpoint) {
    lastConversationSetup.model = model;
    localStorage.setItem(firstLocalConvoKey, JSON.stringify(lastConversationSetup));
  }

  const lastSelectedModels = JSON.parse(
    (localStorage.getItem(LocalStorageKeys.LAST_MODEL) ?? '{}') || '{}',
  );
  lastSelectedModels[endpoint] = model;
  localStorage.setItem(LocalStorageKeys.LAST_MODEL, JSON.stringify(lastSelectedModels));
}

interface ConversationInitParams {
  conversation: t.TConversation | null;
  newEndpoint: EModelEndpoint | string | null;
  endpointsConfig: t.TEndpointsConfig;
  modularChat?: boolean;
}

interface InitiatedTemplateResult {
  template: Partial<t.TPreset>;
  shouldSwitch: boolean;
  isExistingConversation: boolean;
  isCurrentModular: boolean;
  isNewModular: boolean;
  newEndpointType: EModelEndpoint | undefined;
}

/** Get the conditional logic for switching conversations */
export function getConvoSwitchLogic(params: ConversationInitParams): InitiatedTemplateResult {
  const { conversation, newEndpoint, endpointsConfig, modularChat = false } = params;

  const currentEndpoint = conversation?.endpoint;
  const template: Partial<t.TPreset> = {
    ...conversation,
    endpoint: newEndpoint,
    conversationId: 'new',
  };

  const isAssistantSwitch =
    isAssistantsEndpoint(newEndpoint) &&
    isAssistantsEndpoint(currentEndpoint) &&
    currentEndpoint === newEndpoint;

  const conversationId = conversation?.conversationId ?? '';
  const isExistingConversation = !!(conversationId && conversationId !== 'new');

  const currentEndpointType =
    getEndpointField(endpointsConfig, currentEndpoint, 'type') ?? currentEndpoint;
  const newEndpointType =
    getEndpointField(endpointsConfig, newEndpoint, 'type') ??
    (newEndpoint as EModelEndpoint | undefined);

  const hasEndpoint = modularEndpoints.has(currentEndpoint ?? '');
  const hasCurrentEndpointType = modularEndpoints.has(currentEndpointType ?? '');
  const isCurrentModular = hasEndpoint || hasCurrentEndpointType || isAssistantSwitch;

  const hasNewEndpoint = modularEndpoints.has(newEndpoint ?? '');
  const hasNewEndpointType = modularEndpoints.has(newEndpointType ?? '');
  const isNewModular = hasNewEndpoint || hasNewEndpointType || isAssistantSwitch;

  const endpointsMatch = currentEndpoint === newEndpoint;
  const shouldSwitch = endpointsMatch || modularChat || isAssistantSwitch;

  return {
    template,
    shouldSwitch,
    isExistingConversation,
    isCurrentModular,
    newEndpointType,
    isNewModular,
  };
}

export function getModelSpec({
  specName,
  startupConfig,
}: {
  specName?: string | null;
  startupConfig?: t.TStartupConfig;
}): t.TModelSpec | undefined {
  if (!startupConfig || !specName) {
    return;
  }
  return startupConfig.modelSpecs?.list?.find((spec) => spec.name === specName);
}

export function applyModelSpecEphemeralAgent({
  convoId,
  modelSpec,
  updateEphemeralAgent,
}: {
  convoId?: string | null;
  modelSpec?: t.TModelSpec;
  updateEphemeralAgent: ((convoId: string, agent: t.TEphemeralAgent | null) => void) | undefined;
}) {
  if (!modelSpec || !updateEphemeralAgent) {
    return;
  }
  updateEphemeralAgent((convoId ?? Constants.NEW_CONVO) || Constants.NEW_CONVO, {
    mcp: modelSpec.mcpServers ?? [Constants.mcp_clear as string],
    web_search: modelSpec.webSearch ?? false,
    file_search: modelSpec.fileSearch ?? false,
    execute_code: modelSpec.executeCode ?? false,
  });
}

/**
 * Gets default model spec from config and user preferences.
 * Priority: admin default → last selected → first spec (when prioritize=true or modelSelect disabled).
 * Otherwise: admin default or last conversation spec.
 */
export function getDefaultModelSpec(startupConfig?: t.TStartupConfig):
  | {
      default?: t.TModelSpec;
      last?: t.TModelSpec;
    }
  | undefined {
  const { modelSpecs, interface: interfaceConfig } = startupConfig ?? {};
  const { list, prioritize, enforce } = modelSpecs ?? {};
  if (!list || list.length === 0) {
    return;
  }
  const defaultSpec = list?.find((spec) => spec.default);
  const lastSelectedSpecName = localStorage.getItem(LocalStorageKeys.LAST_SPEC);
  const lastConversationSetup = JSON.parse(
    localStorage.getItem(LocalStorageKeys.LAST_CONVO_SETUP + '_0') ?? '{}',
  );

  // If prioritize is true, enforce is true, or model selection is disabled, use default or first spec
  if (prioritize === true || enforce === true || !interfaceConfig?.modelSelect) {
    const lastSelectedSpec = list?.find((spec) => spec.name === lastSelectedSpecName);
    return { default: defaultSpec || lastSelectedSpec || list?.[0] };
  }

  // Branch 2: Check LAST_SPEC from localStorage (for new conversations after modelSpec selection)
  if (lastSelectedSpecName) {
    const lastSelectedSpec = list?.find((spec) => spec.name === lastSelectedSpecName);
    if (lastSelectedSpec) {
      console.log('🔍 [getDefaultModelSpec] Using last selected spec:', lastSelectedSpec.name);
      return { last: lastSelectedSpec };
  }
  }

  // Check last conversation setup
  if (lastConversationSetup.spec) {
    const foundSpec = list?.find((spec) => spec.name === lastConversationSetup.spec);
    if (foundSpec) {
      console.log(
        '🔍 [getDefaultModelSpec] Using spec from lastConversationSetup:',
        foundSpec.name,
      );
      return { last: foundSpec };
    }
  }

  // If there's a default spec, use it
  if (defaultSpec) {
    console.log('🔍 [getDefaultModelSpec] Using default spec:', defaultSpec.name);
    return { default: defaultSpec };
  }

  // Otherwise, always use the first spec in the list (on login with no history)
  console.log('🔍 [getDefaultModelSpec] No history found, using first spec:', list[0].name);
  return { default: list[0] };
}

export function getModelSpecPreset(modelSpec?: t.TModelSpec) {
  if (!modelSpec) {
    return;
  }
  return {
    ...modelSpec.preset,
    spec: modelSpec.name,
    iconURL: getModelSpecIconURL(modelSpec),
  };
}

/** Gets the default spec iconURL by order or definition.
 *
 * First, the admin defined default, then last selected spec, followed by first spec
 */
export function getModelSpecIconURL(modelSpec: t.TModelSpec) {
  return modelSpec.iconURL ?? modelSpec.preset.iconURL ?? modelSpec.preset.endpoint ?? '';
}

/** Gets the default frontend-facing endpoint, dependent on iconURL definition.
 *
 * If the iconURL is defined in the endpoint config, use it, otherwise use the endpoint
 */
export function getIconEndpoint({
  endpointsConfig,
  iconURL,
  endpoint,
}: {
  endpointsConfig?: t.TEndpointsConfig;
  iconURL?: string | null;
  endpoint?: string | null;
}) {
  return (endpointsConfig?.[iconURL ?? ''] ? (iconURL ?? endpoint) : endpoint) ?? '';
}

/** Gets the key to use for the default endpoint iconURL, as defined by the custom config */
export function getIconKey({
  endpoint,
  endpointType: _eType,
  endpointsConfig,
  endpointIconURL: iconURL,
}: {
  endpoint?: string | null;
  endpointsConfig?: t.TEndpointsConfig | null;
  endpointType?: string | null;
  endpointIconURL?: string;
}): keyof IconsRecord {
  const endpointType = _eType ?? getEndpointField(endpointsConfig, endpoint, 'type') ?? '';
  const endpointIconURL = iconURL ?? getEndpointField(endpointsConfig, endpoint, 'iconURL') ?? '';
  if (endpointIconURL && EModelEndpoint[endpointIconURL] != null) {
    return endpointIconURL;
  }
  return endpointType ? 'unknown' : (endpoint ?? 'unknown');
}

export const getEntity = ({
  endpoint,
  assistant_id,
  agent_id,
  agentsMap,
  assistantMap,
}: {
  endpoint: EModelEndpoint | string | null | undefined;
  assistant_id: string | undefined;
  agent_id: string | undefined;
  agentsMap: t.TAgentsMap | undefined;
  assistantMap: t.TAssistantsMap | undefined;
}): {
  entity: t.Agent | t.Assistant | undefined | null;
  isAgent: boolean;
  isAssistant: boolean;
} => {
  const isAgent = isAgentsEndpoint(endpoint);
  const isAssistant = isAssistantsEndpoint(endpoint);

  if (isAgent) {
    const agent = agentsMap?.[agent_id ?? ''];
    return { entity: agent, isAgent, isAssistant };
  } else if (isAssistant) {
    const assistant = assistantMap?.[endpoint ?? '']?.[assistant_id ?? ''];
    return { entity: assistant, isAgent, isAssistant };
  }
  return { entity: null, isAgent, isAssistant };
};
