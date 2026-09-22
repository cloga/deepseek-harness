/**
 * `model` namespace dictionaries.
 *
 * `trigger.selectAria` intentionally matches `trigger.fallback` but remains a
 * separate key: the visible fallback label and the accessible name of
 * an unset trigger are free to diverge per locale, and folding it into
 * `trigger.aria` would announce the degenerate "Select model, current Select
 * model".
 */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'command.label': '模型',
  'command.description': '选择本会话使用的模型',
  'option.loadError': '目录加载失败：{message}',
  'option.deepseekV4Flash.description': '快速、高效且经济；适合目标明确、常规或并行任务。',
  'option.deepseekV4Pro.description': '更强的自主编码、知识与复杂推理能力；适合复杂或质量优先的任务，但成本更高。',
  'trigger.fallback': '选择模型',
  'trigger.loading': '正在加载模型…',
  'trigger.selectAria': '选择模型',
  'trigger.aria': '选择模型，当前 {model}',
  'trigger.ariaEffort': '选择模型，当前 {model}，推理等级 {effort}',
  'menu.aria': '模型与推理等级',
  'menu.model': '模型',
  'menu.effort': '推理等级',
  'auto.label': 'Auto',
  'auto.manual': '手动选择',
  'auto.efficiency': '省钱优先',
  'auto.balanced': '均衡',
  'auto.intelligence': '质量优先',
  'auto.efficiencyDetail': '按任务选择足够胜任、相对成本较低的模型与推理等级。',
  'auto.balancedDetail': '按任务在配置的质量要求与相对成本之间取舍。',
  'auto.intelligenceDetail': '优先满足更高质量要求；简单任务仍可使用较轻的模型。',
  'auto.unavailable': '请先在设置中配置并启用 Auto 路由策略。',
  'auto.trigger': 'Auto · {mode}',
  'auto.triggerAria': '模型自动选择，当前策略 {mode}',
  'auto.pending': '任务开始时选择模型与推理等级',
  'auto.lastUsed': '上次实际使用：{model}',
  'auto.lastUsedEffort': '上次实际使用：{model} · {effort}',
  'auto.effortManaged': '推理等级随任务自动选择；指定模型可切回手动模式。',
  'effort.providerDefault': 'Default',
  'status.loading': '正在刷新模型列表…',
  'error.action': '模型操作失败：{message}',
  'action.reload': '重新加载',
  'warning.groupLoad': '{name} 加载失败：{message}',
  'empty.models': '没有可用的模型。',
  'blocked.composer': '当前模型不可用，请先选择模型',
  'empty.efforts': '当前模型未提供推理等级。',
} satisfies Record<string, string>

/** The model namespace key union. */
export type ModelKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'command.label': 'Model',
  'command.description': 'Select the model for this conversation',
  'option.loadError': 'Catalog failed to load: {message}',
  'option.deepseekV4Flash.description': 'Fast, efficient, and economical; suited to focused, routine, or parallel tasks.',
  'option.deepseekV4Pro.description': 'Stronger agentic coding, knowledge, and difficult reasoning; suited to complex or quality-critical tasks at higher cost.',
  'trigger.fallback': 'Select model',
  'trigger.loading': 'Loading models…',
  'trigger.selectAria': 'Select model',
  'trigger.aria': 'Select model, current {model}',
  'trigger.ariaEffort': 'Select model, current {model}, reasoning effort {effort}',
  'menu.aria': 'Model and reasoning effort',
  'menu.model': 'Model',
  'menu.effort': 'Effort',
  'auto.label': 'Auto',
  'auto.manual': 'Manual selection',
  'auto.efficiency': 'Efficiency',
  'auto.balanced': 'Balance',
  'auto.intelligence': 'Intelligence',
  'auto.efficiencyDetail': 'Choose a capable model and effort combination with lower configured relative cost for the task.',
  'auto.balancedDetail': 'Balance the configured quality requirements and relative cost for each task.',
  'auto.intelligenceDetail': 'Prioritize higher quality requirements; simple work can still use lighter models.',
  'auto.unavailable': 'Configure and enable an Auto routing policy in Settings first.',
  'auto.trigger': 'Auto · {mode}',
  'auto.triggerAria': 'Automatic model selection, current strategy {mode}',
  'auto.pending': 'Model and effort are selected when the task starts',
  'auto.lastUsed': 'Last used: {model}',
  'auto.lastUsedEffort': 'Last used: {model} · {effort}',
  'auto.effortManaged': 'Effort is chosen with the task; select a model to return to manual mode.',
  'effort.providerDefault': 'Default',
  'status.loading': 'Refreshing model list…',
  'error.action': 'Model operation failed: {message}',
  'action.reload': 'Reload',
  'warning.groupLoad': '{name} failed to load: {message}',
  'empty.models': 'No models available.',
  'blocked.composer': 'This model is unavailable — select one to continue',
  'empty.efforts': 'This model provides no reasoning effort levels.',
} satisfies Record<ModelKey, string>
