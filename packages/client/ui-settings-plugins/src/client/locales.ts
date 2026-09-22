/** Locale bundles for the built-in plugins settings section and the plugin configuration pages. */

/** Locale keys these surfaces render. */
export type PluginsSettingsLocaleKey =
  | 'nav' | 'title' | 'intro' | 'tabs' | 'empty'
  | 'overridden' | 'reset' | 'readOnly' | 'unavailable'
  | 'save' | 'saving' | 'saveFailed' | 'invalidNumber'
  | 'bashTitle' | 'bashDescription' | 'bashTimeoutMs' | 'bashTimeoutMsHint'
  | 'bashMaxOutputBytes' | 'bashMaxOutputBytesHint'
  | 'agentLoopTitle' | 'agentLoopDescription' | 'agentLoopMaxParallel' | 'agentLoopMaxParallelHint'
  | 'webSearchTitle' | 'webSearchDescription'
  | 'webSearchApiKey' | 'webSearchApiKeyHint' | 'webSearchApiKeySet' | 'webSearchApiKeyUnset'
  | 'webSearchBaseUrl' | 'webSearchBaseUrlHint' | 'webSearchMaxUses' | 'webSearchMaxUsesHint'
  | 'subagentTitle' | 'subagentDescription' | 'subagentLimitsTitle'
  | 'subagentMaxDepth'
  | 'subagentDepthHelpLabel' | 'subagentDepthHelp'
  | 'subagentDepthZero' | 'subagentDepthOne' | 'subagentDepthOverride'
  | 'subagentMaxActive'
  | 'subagentCapacityHelpLabel' | 'subagentCapacityHelp'
  | 'subagentDepthInvalid'
  | 'subagentCapacityInvalid'
  | 'subagentRulesTitle' | 'subagentRulesHint' | 'subagentRulesPriority' | 'subagentRulesEmpty' | 'subagentRulesForkHint'
  | 'subagentRulesAdd' | 'subagentRulesRemove' | 'subagentRulesParent' | 'subagentRulesChild'
  | 'subagentRulesProvider' | 'subagentRulesModel' | 'subagentRulesChoose'
  | 'subagentRulesIncomplete' | 'subagentRulesDuplicate' | 'subagentRulesUnsupported'
  | 'subagentRulesUnsaved' | 'subagentRulesSaved' | 'subagentRulesUnavailable'
  | 'subagentModelSelectionTitle'
  | 'subagentModelSelectionToggle' | 'subagentModelSelectionChoose' | 'subagentModelSelectionAllowed'
  | 'subagentModelSelectionLoading' | 'subagentModelSelectionLoadFailed' | 'subagentModelSelectionRetry'
  | 'subagentModelSelectionPartial' | 'subagentModelSelectionUnavailable'
  | 'subagentModelSelectionUnavailableGroup' | 'subagentModelSelectionEmpty'
  | 'subagentModelSelectionRequired' | 'subagentModelSelectionConflict' | 'subagentModelSelectionOff'

/** English copy. */
export const en: Record<PluginsSettingsLocaleKey, string> = {
  nav: 'Built-in plugins',
  title: 'Built-in plugins',
  intro: 'Inspect the plugins this deployment ships.',
  tabs: 'Plugin views',
  empty: 'This deployment exposes no plugin views.',
  overridden: 'Overridden',
  reset: 'Reset to default',
  readOnly: 'This deployment stores settings read-only.',
  unavailable: 'This plugin is not loaded, so it cannot be configured right now.',
  save: 'Save',
  saving: 'Saving…',
  saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
  invalidNumber: 'Enter a number, or leave blank to use the default.',
  bashTitle: 'Shell',
  bashDescription: 'Limits every command the agent runs.',
  bashTimeoutMs: 'Command timeout (ms)',
  bashTimeoutMsHint: 'How long one command may run before it is terminated.',
  bashMaxOutputBytes: 'Output cap per stream (bytes)',
  bashMaxOutputBytesHint: 'Output beyond this spills to a temporary file rather than being lost.',
  agentLoopTitle: 'Agent loop',
  agentLoopDescription: 'How the agent dispatches tool calls.',
  agentLoopMaxParallel: 'Parallel tool calls',
  agentLoopMaxParallelHint: 'Upper bound on parallel-safe calls running at once within one step.',
  webSearchTitle: 'Web search',
  webSearchDescription: 'The DeepSeek search provider.',
  webSearchApiKey: 'API key',
  webSearchApiKeyHint: 'Stored outside the settings file. Leave blank to keep the current key.',
  webSearchApiKeySet: 'A key is configured.',
  webSearchApiKeyUnset: 'No key is configured; search is unavailable until one is.',
  webSearchBaseUrl: 'Endpoint',
  webSearchBaseUrlHint: 'Leave blank to use the provider default.',
  webSearchMaxUses: 'Max searches per request',
  webSearchMaxUsesHint: 'How many times one request may search before it must answer.',
  subagentTitle: 'Subagent',
  subagentDescription: 'Set Subagent recursion depth, count, and models.',
  subagentLimitsTitle: 'Limits',
  subagentMaxDepth: 'Maximum recursion depth',
  subagentDepthHelpLabel: 'About maximum recursion depth',
  subagentDepthHelp: 'Limits how many levels of Subagents an Agent can create.',
  subagentDepthZero: 'Disable Subagents',
  subagentDepthOne: 'Only the main Agent can create Subagents',
  subagentDepthOverride: 'If a tool defines its own maximum recursion depth, that setting takes precedence.',
  subagentMaxActive: 'Subagent parallelism limit',
  subagentCapacityHelpLabel: 'About the Subagent parallelism limit',
  subagentCapacityHelp: 'Total live Subagents under the same main Agent, across all recursion levels. The main Agent is excluded. New start requests are rejected when the limit is reached.',
  subagentDepthInvalid: 'Enter a whole number of 0 or more.',
  subagentCapacityInvalid: 'Enter a whole number of 1 or more.',
  subagentRulesTitle: 'Default model rules',
  subagentRulesHint: 'For future Subagents that support model configuration and otherwise inherit their parent’s model, match the direct parent’s exact provider and model to choose a default. Each creation matches once; rules do not chain or change existing or resumed agents.',
  subagentRulesPriority: 'Explicit authorized model and effort choices and caller-configured LLM options take priority. Providers with fixed defaults or their own model controls are unchanged. These defaults do not grant agents permission to choose models. The main model remains Session-owned.',
  subagentRulesEmpty: 'No rules: model-configurable Subagents inherit their direct parent’s model unless an explicit or configured choice takes priority. Other providers keep their own model controls.',
  subagentRulesForkHint: 'Rules also apply to compatible forks. Changing a fork’s model may forfeit inherited-prefix cache reuse and require reprocessing history; lower cost is not guaranteed. This human-authored default does not enable AI model choice for forks.',
  subagentRulesAdd: 'Add rule',
  subagentRulesRemove: 'Remove rule',
  subagentRulesParent: 'When the parent uses',
  subagentRulesChild: 'Default for the child',
  subagentRulesProvider: 'Provider',
  subagentRulesModel: 'Model',
  subagentRulesChoose: 'Choose…',
  subagentRulesIncomplete: 'Choose a provider and model for both sides of every rule, or remove the incomplete row.',
  subagentRulesDuplicate: 'Each parent provider and model pair can have only one rule. Remove or edit duplicate rows.',
  subagentRulesUnsupported: 'This Host does not advertise model-rule settings. Defaults cannot be edited here.',
  subagentRulesUnsaved: 'Unsaved rule changes',
  subagentRulesSaved: 'Rules match saved settings; model availability is not verified by saving.',
  subagentRulesUnavailable: 'This route is not in the current catalog. Its exact IDs are retained; choose another route or remove the rule.',
  subagentModelSelectionTitle: 'Model selection',
  subagentModelSelectionToggle: 'Allow agents to choose models for Subagents',
  subagentModelSelectionChoose: 'When enabled, agents can choose a provider, model, and reasoning effort for each Subagent from the authorized models below. Applies only to new sessions.',
  subagentModelSelectionAllowed: 'Models agents may choose',
  subagentModelSelectionLoading: 'Loading models…',
  subagentModelSelectionLoadFailed: 'Models could not be loaded.',
  subagentModelSelectionRetry: 'Retry',
  subagentModelSelectionPartial: 'Some model providers could not be loaded; saved choices remain removable.',
  subagentModelSelectionUnavailable: 'Currently unavailable',
  subagentModelSelectionUnavailableGroup: 'Saved but currently unavailable',
  subagentModelSelectionEmpty: 'No model provider currently advertises a model.',
  subagentModelSelectionRequired: 'Select at least one model before saving.',
  subagentModelSelectionConflict: 'Settings changed elsewhere. Discard your draft and try again.',
  subagentModelSelectionOff: 'Subagents use configured defaults or inherit the parent agent\'s model. Saved model choices are retained.',
}

/** Simplified Chinese copy. */
export const zh: Record<PluginsSettingsLocaleKey, string> = {
  nav: '内置插件',
  title: '内置插件',
  intro: '查看内置部署的插件列表',
  tabs: '插件视图',
  empty: '本部署没有开放任何插件视图。',
  overridden: '已覆盖',
  reset: '恢复默认',
  readOnly: '本部署的设置为只读。',
  unavailable: '该插件当前未加载，暂时无法配置。',
  save: '保存',
  saving: '保存中…',
  saveFailed: '本部署没有接受这些值，已保留供你修改。',
  invalidNumber: '请填数字；留空表示使用默认值。',
  bashTitle: '终端',
  bashDescription: '限制 agent 运行的每一条命令。',
  bashTimeoutMs: '命令超时（毫秒）',
  bashTimeoutMsHint: '单条命令允许运行多久，超时即终止。',
  bashMaxOutputBytes: '单流输出上限（字节）',
  bashMaxOutputBytesHint: '超出部分会转存到临时文件，而不是被丢弃。',
  agentLoopTitle: 'Agent 循环',
  agentLoopDescription: 'Agent 如何派发工具调用。',
  agentLoopMaxParallel: '并行工具调用数',
  agentLoopMaxParallelHint: '同一步内最多同时运行多少个可并行的调用。',
  webSearchTitle: '网页搜索',
  webSearchDescription: 'DeepSeek 搜索提供方。',
  webSearchApiKey: 'API Key',
  webSearchApiKeyHint: '不写入设置文件。留空表示保持当前密钥。',
  webSearchApiKeySet: '已配置密钥。',
  webSearchApiKeyUnset: '未配置密钥；配置之前搜索不可用。',
  webSearchBaseUrl: '接口地址',
  webSearchBaseUrlHint: '留空则使用提供方默认地址。',
  webSearchMaxUses: '单次请求最多搜索次数',
  webSearchMaxUsesHint: '一次请求在必须作答前最多可以搜索多少次。',
  subagentTitle: 'Subagent',
  subagentDescription: '设置 Subagent 的递归层级、数量和模型。',
  subagentLimitsTitle: '运行限制',
  subagentMaxDepth: '最大递归深度',
  subagentDepthHelpLabel: '最大递归深度说明',
  subagentDepthHelp: '限制 Agent 创建 Subagent 的递归层级。',
  subagentDepthZero: '禁用 Subagent',
  subagentDepthOne: '仅允许主 Agent 创建 Subagent',
  subagentDepthOverride: '如果某个工具单独设置了最大递归深度，以该工具的设置为准。',
  subagentMaxActive: 'Subagent 并行数量上限',
  subagentCapacityHelpLabel: 'Subagent 并行数量上限说明',
  subagentCapacityHelp: '同一主 Agent 下，所有递归层级同时存活的 Subagent 总数，主 Agent 不计入。达到上限时，新的启动请求会被拒绝。',
  subagentDepthInvalid: '请输入不小于 0 的整数。',
  subagentCapacityInvalid: '请输入不小于 1 的整数。',
  subagentRulesTitle: '默认模型规则',
  subagentRulesHint: '规则适用于未来创建、支持模型配置且原本会继承父模型的 Subagent，按直接父 Agent 的精确提供方和模型匹配默认模型。每次创建只匹配一次，不连续套用规则，也不改变已有或恢复的 Agent。',
  subagentRulesPriority: '已授权的显式模型与推理强度选择，以及调用方配置的 LLM 选项优先。提供方的固定默认模型或自有模型控制保持不变。这些默认规则不会授予 Agent 选择模型的权限。主模型仍由 Session 管理。',
  subagentRulesEmpty: '没有规则：支持模型配置的 Subagent 继承直接父 Agent 的模型，除非存在优先的显式选择或配置。其他提供方保留自有模型控制。',
  subagentRulesForkHint: '规则也适用于兼容的分叉。更换分叉子 Agent 的模型可能失去继承前缀的缓存复用，需要重新处理历史，并不保证降低成本。此用户设定的默认规则不会开启 AI 为分叉选择模型的权限。',
  subagentRulesAdd: '添加规则',
  subagentRulesRemove: '移除规则',
  subagentRulesParent: '当父 Agent 使用',
  subagentRulesChild: '子 Agent 默认使用',
  subagentRulesProvider: '提供方',
  subagentRulesModel: '模型',
  subagentRulesChoose: '请选择…',
  subagentRulesIncomplete: '请为每条规则的两端选择提供方和模型，或移除未完成的行。',
  subagentRulesDuplicate: '每个父 Agent 提供方和模型组合只能有一条规则。请移除或修改重复行。',
  subagentRulesUnsupported: '此 Host 未声明支持模型规则设置，无法在此编辑默认规则。',
  subagentRulesUnsaved: '规则修改尚未保存',
  subagentRulesSaved: '规则与已保存设置一致；保存不代表模型已验证可用。',
  subagentRulesUnavailable: '当前目录中没有此路由。精确 ID 已保留；可选择其他路由或移除规则。',
  subagentModelSelectionTitle: '模型选择',
  subagentModelSelectionToggle: '允许 Agent 为 Subagent 选择模型',
  subagentModelSelectionChoose: '开启后，Agent 可以从下方授权模型中，为每个 Subagent 选择提供方、模型和推理强度。仅影响新会话。',
  subagentModelSelectionAllowed: 'Agent 可选择的模型',
  subagentModelSelectionLoading: '正在加载模型…',
  subagentModelSelectionLoadFailed: '无法加载模型。',
  subagentModelSelectionRetry: '重试',
  subagentModelSelectionPartial: '部分模型提供方暂时无法加载；已保存的选择仍可移除。',
  subagentModelSelectionUnavailable: '当前不可用',
  subagentModelSelectionUnavailableGroup: '已保存但当前不可用',
  subagentModelSelectionEmpty: '当前没有模型提供方公布模型。',
  subagentModelSelectionRequired: '保存前请至少选择一个模型。',
  subagentModelSelectionConflict: '设置已在其他位置更新。请放弃修改后重试。',
  subagentModelSelectionOff: '关闭后，Subagent 使用配置的默认模型或继承父 Agent 的模型；已选模型会保留。',
}
