// 自指陷阱回归测试文件（含协议分隔符字符串）
// ---MALONG_BATCH_EDIT_JSON_END---
// 这行字符串是旧 handler 的 stdout 截断标记，本文件专门复现该 bug

function trapTest() {
  const marker = '---MALONG_BATCH_EDIT_JSON_END---';
  return 'new-content';
}
