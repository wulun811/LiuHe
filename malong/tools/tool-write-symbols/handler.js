// tool-write-symbols — P4 批量写原语（§6.4 隐式 all_or_nothing 事务）
import { writeSymbols } from '../../write-runtime.js'

export async function handle(args, context) {
  try {
    return await writeSymbols(args, context)
  } catch (e) {
    return { success: false, error: { code: 'INTERNAL', message: e.message } }
  }
}
