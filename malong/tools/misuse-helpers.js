/**
 * 工具误用检测 - 共享工具函数
 * 
 * 提供统一的判断原语，供各工具 handler 使用
 */

// 函数名模式：动词前缀或 snake_case
const VERB_PREFIXES = /^(get|set|handle|process|create|delete|update|find|check|validate|login|logout|register|send|fetch|load|save|init|start|stop|run|execute|parse|format|convert|transform|filter|sort|map|reduce|count|verify|authenticate|authorize|encrypt|decrypt|encode|decode|read|write|open|close|connect|disconnect|subscribe|unsubscribe|emit|on|off|add|remove|insert|append|push|pop|shift|unshift)/

/**
 * 判断是否为函数名
 * - 动词前缀（get/set/handle/...）
 * - snake_case（包含下划线且非全大写）
 */
export function isFunctionName(symbol) {
  if (!symbol) return false
  return VERB_PREFIXES.test(symbol) || (symbol.includes('_') && !/^[A-Z_]+$/.test(symbol))
}

/**
 * 判断是否为常量名
 * - 全大写字母 + 数字 + 下划线
 * - 长度 > 2（避免误判单字母常量）
 */
export function isConstantName(symbol) {
  if (!symbol) return false
  return /^[A-Z][A-Z0-9_]*$/.test(symbol) && symbol.length > 2
}

/**
 * 构造误用警告
 */
export function misuseWarning(suggestedTool, suggestion) {
  return {
    warning: 'likely_wrong_tool',
    suggestion: suggestion
  }
}

/**
 * 构造工具切换建议
 */
export function suggestTool(toolName, reason) {
  return `For ${reason}, use ${toolName}.`
}
