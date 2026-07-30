import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

class Config {
  constructor(path) {
    this.path = path
    this.data = {}
  }

  load() {
    try {
      const content = readFileSync(this.path, 'utf-8')
      this.data = JSON.parse(content)
    } catch {
      this.data = {}
    }
    return this
  }

  save() {
    writeFileSync(this.path, JSON.stringify(this.data, null, 2))
  }

  get(key, defaultValue = null) {
    return this.data[key] ?? defaultValue
  }

  set(key, value) {
    this.data[key] = value
  }
}

export function createConfig(path) {
  return new Config(path).load()
}

export { Config }
