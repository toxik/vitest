import type { CoverageMapData } from 'istanbul-lib-coverage'
import type { Profiler } from 'node:inspector'
import type { Vite } from 'vitest/node'
import astV8ToIstanbul from 'ast-v8-to-istanbul'
import { parseAstAsync } from 'vitest/node'

export interface RemapCoveragePayload {
  code: string
  map?: Vite.Rollup.SourceMap
  url: string
  wrapperLength: number
  functions: Profiler.FunctionCoverage[]
  ignoreClassMethods?: string[]
}

/**
 * Parse `payload.code` and remap raw V8 function coverage into an Istanbul
 * coverage map. This is the CPU-bound step of the V8 coverage pipeline and is
 * intentionally free of any main-thread state (no Vite server, no logger) so it
 * can run either inline or inside a worker thread, see {@link file://./worker.ts}.
 */
export async function convertToIstanbul(payload: RemapCoveragePayload): Promise<CoverageMapData> {
  const ast = await parseAstAsync(payload.code)

  return await astV8ToIstanbul({
    code: payload.code,
    sourceMap: payload.map,
    ast,
    coverage: { functions: payload.functions, url: payload.url },
    ignoreClassMethods: payload.ignoreClassMethods,
    wrapperLength: payload.wrapperLength,
    ignoreNode: (node, type) => {
      // SSR transformed imports
      if (
        type === 'statement'
        && node.type === 'VariableDeclarator'
        && node.id.type === 'Identifier'
        && node.id.name.startsWith('__vite_ssr_import_')
      ) {
        return true
      }

      // SSR transformed exports vite@>6.3.5
      if (
        type === 'statement'
        && node.type === 'ExpressionStatement'
        && node.expression.type === 'AssignmentExpression'
        && node.expression.left.type === 'MemberExpression'
        && node.expression.left.object.type === 'Identifier'
        && node.expression.left.object.name === '__vite_ssr_exports__'
      ) {
        return true
      }

      // SSR transformed exports vite@^6.3.5
      if (
        type === 'statement'
        && node.type === 'VariableDeclarator'
        && node.id.type === 'Identifier'
        && node.id.name === '__vite_ssr_export_default__'
      ) {
        return true
      }

      // CJS imports as ternaries - e.g.
      // const React = __vite__cjsImport0_react.__esModule ? __vite__cjsImport0_react.default : __vite__cjsImport0_react;
      if (
        type === 'branch'
        && node.type === 'ConditionalExpression'
        && node.test.type === 'MemberExpression'
        && node.test.object.type === 'Identifier'
        && node.test.object.name.startsWith('__vite__cjsImport')
        && node.test.property.type === 'Identifier'
        && node.test.property.name === '__esModule'
      ) {
        return true
      }

      // in-source test with "if (import.meta.vitest)"
      if (
        (type === 'branch' || type === 'statement')
        && node.type === 'IfStatement'
        && node.test.type === 'MemberExpression'
        && node.test.property.type === 'Identifier'
        && node.test.property.name === 'vitest'
      ) {
        // SSR
        if (
          node.test.object.type === 'Identifier'
          && node.test.object.name === '__vite_ssr_import_meta__'
        ) {
          return 'ignore-this-and-nested-nodes'
        }

        // Web
        if (
          node.test.object.type === 'MetaProperty'
          && node.test.object.meta.name === 'import'
          && node.test.object.property.name === 'meta'
        ) {
          return 'ignore-this-and-nested-nodes'
        }
      }

      // Browser mode's "import.meta.env ="
      if (
        type === 'statement'
        && node.type === 'ExpressionStatement'
        && node.expression.type === 'AssignmentExpression'
        && node.expression.left.type === 'MemberExpression'
        && node.expression.left.object.type === 'MetaProperty'
        && node.expression.left.object.meta.name === 'import'
        && node.expression.left.object.property.name === 'meta'
        && node.expression.left.property.type === 'Identifier'
        && node.expression.left.property.name === 'env'
      ) {
        return true
      }

      // SSR mode's "import.meta.env ="
      if (
        type === 'statement'
        && node.type === 'ExpressionStatement'
        && node.expression.type === 'AssignmentExpression'
        && node.expression.left.type === 'MemberExpression'
        && node.expression.left.object.type === 'Identifier'
        && node.expression.left.object.name === '__vite_ssr_import_meta__'
      ) {
        return true
      }

      // SWC's decorators
      if (
        type === 'statement'
        && node.type === 'ExpressionStatement'
        && node.expression.type === 'CallExpression'
        && node.expression.callee.type === 'Identifier'
        && node.expression.callee.name === '_ts_decorate'
      ) {
        return 'ignore-this-and-nested-nodes'
      }
    },
  })
}
