import { readFileSync, existsSync } from 'node:fs'
import { join, extname, basename } from 'node:path'

export const name = 'tool-spec-gen'
export const version = '0.1.0'

let _core

function parseJSON(text) {
  try { return JSON.parse(text) } catch {}
  try { return JSON.parse(text.replace(/,\s*([\]}])/g, '$1')) } catch {}
  return null
}

function extractRoutes(spec) {
  const routes = []
  const paths = spec?.paths || {}
  for (const [path, methods] of Object.entries(paths)) {
    for (const [method, info] of Object.entries(methods)) {
      if (!['get', 'post', 'put', 'delete', 'patch'].includes(method)) continue
      const params = (info.parameters || []).map(p => ({
        name: p.name, in: p.in, required: p.required !== false,
        type: p.schema?.type || 'string', description: p.description || '',
      }))
      const requestBody = info.requestBody?.content?.['application/json']?.schema
      const responses = info.responses || {}
      const statusCodes = Object.keys(responses).map(Number).filter(n => !isNaN(n))
      routes.push({
        path, method: method.toUpperCase(),
        summary: info.summary || '',
        operationId: info.operationId || '',
        params,
        requestBody,
        responses: statusCodes,
        tags: info.tags || [],
      })
    }
  }
  return routes
}

function typeFromSchema(schema) {
  if (!schema) return 'any'
  if (schema.$ref) return schema.$ref.split('/').pop()
  if (schema.type === 'array') return `${typeFromSchema(schema.items || {})}[]`
  if (schema.type === 'integer') return 'number'
  if (schema.type === 'object') return 'Record<string, any>'
  return schema.type || 'any'
}

function generateExpressHandler(route) {
  const { method, path, params, operationId } = route
  let fnName = operationId || path.replace(/[{}]/g, '').split('/').filter(Boolean).join('_')
  if (!fnName) fnName = `${method.toLowerCase()}_${path.replace(/[^a-zA-Z0-9]/g, '_')}`
  fnName = fnName.replace(/[^a-zA-Z0-9_]/g, '_').replace(/_{2,}/g, '_').replace(/^_|_$/g, '')

  let body = ''
  for (const p of params) {
    if (p.in === 'path') body += `  const ${p.name} = req.params.${p.name}\n`
    else if (p.in === 'query') body += `  const ${p.name} = req.query.${p.name}\n`
    else if (p.in === 'header') body += `  const ${p.name} = req.headers.${p.name}\n`
  }

  let routePath = path.replace(/{/g, ':').replace(/}/g, '')
  return { fnName, routePath, code: `async function ${fnName}(req, res, next) {\n${body}  try {\n    // TODO: implement ${fnName}\n    res.json({ ok: true, data: null })\n  } catch (err) {\n    next(err)\n  }\n}` }
}

function generateRouter(moduleName, routes) {
  const imports = routes.map(r => {
    const { fnName, routePath, code } = generateExpressHandler(r)
    return { fnName, routePath, code }
  })

  let router = `import { Router } from 'express'\n\nconst router = Router()\n\n`
  for (const r of imports) {
    router += `// ${r.routePath}\n${r.code}\n\n`
  }
  for (const r of imports) {
    router += `router.${routes[imports.indexOf(r)].method.toLowerCase()}('${r.routePath}', ${r.fnName})\n`
  }
  router += `\nexport default router\n`
  return { imports, router }
}

function generateModel(schema, name) {
  if (!schema || !schema.type) return null
  let code = `// ${name} — auto-generated from spec\n`
  if (schema.type === 'object' && schema.properties) {
    code += `export interface ${name} {\n`
    for (const [prop, propSchema] of Object.entries(schema.properties)) {
      const required = (schema.required || []).includes(prop)
      const tsType = typeFromSchema(propSchema)
      code += `  ${prop}${required ? '' : '?'}: ${tsType}\n`
    }
    code += `}\n`
  }
  return { name, code }
}

export async function init(core) {
  _core = core

  core.registerService('specGen', {
    async parseSpec(filePath) {
      const content = readFileSync(filePath, 'utf8')
      const ext = extname(filePath)
      let spec
      if (ext === '.json') {
        spec = parseJSON(content)
      } else if (ext === '.yaml' || ext === '.yml') {
        try {
          const { load } = await import('js-yaml')
          spec = load(content)
        } catch {
          return { error: 'js-yaml not available, install with: npm install js-yaml' }
        }
      } else return { error: `Unsupported spec format: ${ext}` }

      if (!spec) return { error: 'Failed to parse spec file' }
      return { spec, info: spec.info || {}, openapi: spec.openapi || spec.swagger || '' }
    },

    async generateRoutes(spec) {
      const routes = extractRoutes(spec)
      if (!routes.length) return { error: 'No routes found in spec', routes: [] }
      const moduleName = spec?.info?.title?.replace(/\s+/g, '-').toLowerCase() || 'api'
      const { imports, router } = generateRouter(moduleName, routes)
      return {
        routes: routes.length,
        moduleName,
        handlers: imports,
        routerCode: router,
      }
    },

    async generateModels(spec) {
      const models = []
      const schemas = spec?.components?.schemas || spec?.definitions || {}
      for (const [name, schema] of Object.entries(schemas)) {
        const result = generateModel(schema, name)
        if (result) models.push(result)
      }
      return { models }
    },

    async generateAll(filePath) {
      const parsed = await this.parseSpec(filePath)
      if (parsed.error) return parsed
      const routes = await this.generateRoutes(parsed.spec)
      const models = await this.generateModels(parsed.spec)
      return {
        info: parsed.info,
        routes: routes.routes,
        handlers: routes.handlers || [],
        routerCode: routes.routerCode || '',
        models: models.models || [],
      }
    },

    async verify(filePath, sourceDir) {
      const parsed = await this.parseSpec(filePath)
      if (parsed.error) return parsed
      const routes = extractRoutes(parsed.spec)
      const modelCount = Object.keys(parsed.spec?.components?.schemas || parsed.spec?.definitions || {}).length
      const existingFiles = []
      if (sourceDir && existsSync(sourceDir)) {
        const { readdirSync } = await import('node:fs')
        try { existingFiles.push(...readdirSync(sourceDir).filter(f => f.endsWith('.js') || f.endsWith('.mjs'))) } catch {}
      }
      return {
        specFile: filePath,
        routeCount: routes.length,
        modelCount,
        existingHandlers: existingFiles,
        summary: `${routes.length} routes, ${modelCount} models from spec; ${existingFiles.length} existing files in ${sourceDir || 'N/A'}`,
      }
    },
  })
}
