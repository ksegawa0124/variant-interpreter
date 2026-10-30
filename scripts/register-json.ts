// validate-erepo 等の Node スクリプト用: アプリは JSON を import 属性なしで動的 import するため、
// Node 側では属性なしの .json を JSON モジュールとして読めるようにする。
import { registerHooks } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('.json') && url.startsWith('file:')) {
      return { format: 'module', source: `export default ${readFileSync(fileURLToPath(url), 'utf8')}`, shortCircuit: true }
    }
    return nextLoad(url, context)
  },
})
