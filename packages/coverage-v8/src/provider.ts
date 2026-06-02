import type { CoverageMap } from 'istanbul-lib-coverage'
import type { ProxifiedModule } from 'magicast'
import type { Profiler } from 'node:inspector'
import type { CoverageProvider, ReportContext, TestProject, Vite, Vitest } from 'vitest/node'
import type { RemapWorkerResult } from './worker'
import { existsSync, promises as fs } from 'node:fs'
import { fileURLToPath } from 'node:url'
// @ts-expect-error -- untyped
import { mergeProcessCovs } from '@bcoe/v8-coverage'
import libCoverage from 'istanbul-lib-coverage'
import libReport from 'istanbul-lib-report'
import reports from 'istanbul-reports'
import { parseModule } from 'magicast'
import { createDebug } from 'obug'
import { normalize } from 'pathe'
import { provider } from 'std-env'
import Tinypool from 'tinypool'
import c from 'tinyrainbow'
import { BaseCoverageProvider } from 'vitest/node'
import { version } from '../package.json' with { type: 'json' }
import { convertToIstanbul } from './to-istanbul'

export interface ScriptCoverageWithOffset extends Profiler.ScriptCoverage {
  startOffset: number

  /** Whether script ran outside Vite, e.g. in sub-processes or worker threads */
  isExtendedContext?: boolean
}

interface RawCoverage { result: ScriptCoverageWithOffset[] }

const FILE_PROTOCOL = 'file://'

/**
 * Below this number of files the worker pool is not worth its startup cost
 * (spawning threads + loading the parser in each), so conversion stays inline
 * on the main thread.
 */
const WORKER_POOL_FILE_THRESHOLD = 20

const debug = createDebug('vitest:coverage')

export class V8CoverageProvider extends BaseCoverageProvider implements CoverageProvider {
  name = 'v8' as const
  version: string = version

  private pool: Tinypool | undefined

  /**
   * Lazily spin up a worker pool for the CPU-bound V8 -> Istanbul conversion.
   * No-op when disabled, when concurrency is 1, when the file count is too low
   * to amortize startup, or when a pool already exists.
   */
  private ensurePool(fileCount: number): void {
    if (this.pool) {
      return
    }

    const toggle = process.env.VITEST_COVERAGE_WORKER_POOL

    if (toggle === 'false') {
      return
    }

    const maxThreads = this.options.processingConcurrency

    // `VITEST_COVERAGE_WORKER_POOL=true` forces the pool on regardless of file
    // count (useful for benchmarking); otherwise honor the amortization threshold.
    if (toggle !== 'true' && (maxThreads <= 1 || fileCount < WORKER_POOL_FILE_THRESHOLD)) {
      return
    }

    this.pool = new Tinypool({
      filename: fileURLToPath(new URL('./worker.js', import.meta.url)),
      minThreads: 1,
      maxThreads,
    })

    debug('Created coverage worker pool with %d threads', maxThreads)
  }

  private async destroyPool(): Promise<void> {
    if (this.pool) {
      const pool = this.pool
      this.pool = undefined
      await pool.destroy()
    }
  }

  initialize(ctx: Vitest): void {
    this._initialize(ctx)

    if (this.options.autoAttachSubprocess) {
      const isAnyThreadsPools = ctx.projects.some(p => p.config.pool === 'threads' || p.config.pool === 'vmThreads')

      if (isAnyThreadsPools) {
        // Work-around for https://github.com/nodejs/node/issues/46378
        // Node never does anything with this directory, it's just required so that
        // the next Workers read **their** env.NODE_V8_COVERAGE.
        // Node never creates this .unused directory at all.
        process.env.NODE_V8_COVERAGE = `${this.coverageFilesDirectory}/.unused`
      }
    }
  }

  createCoverageMap(): CoverageMap {
    return libCoverage.createCoverageMap({})
  }

  async generateCoverage({ allTestsRun }: ReportContext): Promise<CoverageMap> {
    const start = debug.enabled ? performance.now() : 0

    const coverageMap = this.createCoverageMap()
    let coverages: RawCoverage[] = []

    // `mergeProcessCovs` drops `startOffset` (e.g. in vue) and `isExtendedContext`,
    // so remember the originals per-url and restore them after the merge.
    const startOffsets = new Map<string, number>()
    const extendedContexts = new Set<string>()

    const autoAttachSubprocess = this.options.autoAttachSubprocess

    try {
      await this.readCoverageFiles<RawCoverage>({
        onFileRead(coverage) {
          coverages.push(coverage)

          for (const result of coverage.result) {
            if (result.startOffset && !startOffsets.has(result.url)) {
              startOffsets.set(result.url, result.startOffset)
            }

            if (autoAttachSubprocess && result.isExtendedContext) {
              extendedContexts.add(result.url)
            }
          }
        },
        onFinished: async (project, environment) => {
          // Merge every process coverage in a single pass. `mergeProcessCovs` is
          // associative, so folding it per-file (`[merged, next]`) is O(n^2) on
          // large suites - merging the whole batch at once is O(n).
          const merged: RawCoverage = coverages.length
            ? mergeProcessCovs(coverages)
            : { result: [] }

          // Restore values dropped by the merge in one pass over the result.
          for (const result of merged.result) {
            if (!result.startOffset) {
              result.startOffset = startOffsets.get(result.url) || 0
            }

            if (autoAttachSubprocess && !result.isExtendedContext && extendedContexts.has(result.url)) {
              result.isExtendedContext = true
            }
          }

          // Source maps can change based on projectName and transform mode.
          // Coverage transform re-uses source maps so we need to separate transforms from each other.
          const converted = await this.convertCoverage(
            merged,
            project,
            environment,
          )

          coverageMap.merge(converted)

          coverages = []
          startOffsets.clear()
          extendedContexts.clear()
        },
        onDebug: debug,
      })

      // Include untested files when all tests were run (not a single file re-run)
      // or if previous results are preserved by "cleanOnRerun: false"
      if (this.options.include != null && (allTestsRun || !this.options.cleanOnRerun)) {
        const coveredFiles = coverageMap.files()
        const untestedCoverage = await this.getCoverageMapForUncoveredFiles(coveredFiles)

        coverageMap.merge(untestedCoverage)
      }

      coverageMap.filter((filename) => {
        const exists = existsSync(filename)

        if (this.options.excludeAfterRemap) {
          return exists && this.isIncluded(filename)
        }

        return exists
      })

      if (debug.enabled) {
        debug(`Generate coverage total time ${(performance.now() - start!).toFixed()} ms`)
      }

      return coverageMap
    }
    finally {
      await this.destroyPool()
    }
  }

  async generateReports(coverageMap: CoverageMap, allTestsRun?: boolean): Promise<void> {
    if (provider === 'stackblitz') {
      this.ctx.logger.log(
        c.blue(' % ')
        + c.yellow(
          '@vitest/coverage-v8 does not work on Stackblitz. Report will be empty.',
        ),
      )
    }

    const context = libReport.createContext({
      dir: this.options.reportsDirectory,
      coverageMap,
      watermarks: this.options.watermarks,
    })

    if (this.hasTerminalReporter(this.options.reporter)) {
      this.ctx.logger.log(
        c.blue(' % ') + c.dim('Coverage report from ') + c.yellow(this.name),
      )
    }

    for (const reporter of this.options.reporter) {
      // Type assertion required for custom reporters
      reports
        .create(reporter[0] as Parameters<typeof reports.create>[0], {
          skipFull: this.options.skipFull,
          projectRoot: this.ctx.config.root,
          ...reporter[1],
        })
        .execute(context)
    }

    if (this.options.thresholds) {
      await this.reportThresholds(coverageMap, allTestsRun)
    }
  }

  async parseConfigModule(configFilePath: string): Promise<ProxifiedModule<any>> {
    const contents = await fs.readFile(configFilePath, 'utf8')

    return parseModule(`${contents}${this.autoUpdateMarker}`)
  }

  private async getCoverageMapForUncoveredFiles(testedFiles: string[]): Promise<CoverageMap> {
    const transform = this.createUncoveredFileTransformer(this.ctx)

    const uncoveredFiles = await this.getUntestedFiles(testedFiles)

    this.ensurePool(uncoveredFiles.length)

    let index = 0

    const coverageMap = this.createCoverageMap()

    for (const chunk of this.toSlices(uncoveredFiles, this.options.processingConcurrency)) {
      if (debug.enabled) {
        index += chunk.length
        debug('Uncovered files %d/%d', index, uncoveredFiles.length)
      }

      await Promise.all(chunk.map(async (filename) => {
        let timeout: ReturnType<typeof setTimeout> | undefined
        let start: number | undefined

        if (debug.enabled) {
          start = performance.now()
          timeout = setTimeout(() => debug(c.bgRed(`File "${filename}" is taking longer than 3s`)), 3_000)
        }

        // Do not use pathToFileURL to avoid encoding filename parts
        const url = `file://${filename[0] === '/' ? '' : '/'}${filename}`

        const sources = await this.getSources(
          url,
          transform,
        )

        coverageMap.merge(await this.remapCoverage(
          url,
          0,
          sources,
          [],
        ))

        if (debug.enabled) {
          clearTimeout(timeout)

          const diff = performance.now() - start!
          const color = diff > 500 ? c.bgRed : c.bgGreen
          debug(`${color(` ${diff.toFixed()} ms `)} ${filename}`)
        }
      }))
    }

    return coverageMap
  }

  private async remapCoverage(filename: string, wrapperLength: number, result: Awaited<ReturnType<typeof this.getSources>>, functions: Profiler.FunctionCoverage[]) {
    const payload = {
      code: result.code,
      map: result.map,
      url: filename,
      wrapperLength,
      functions,
      ignoreClassMethods: this.options.ignoreClassMethods,
    }

    try {
      // Offload the CPU-bound parse + remap to the worker pool when available,
      // otherwise run it inline on the main thread.
      if (this.pool) {
        const response: RemapWorkerResult = await this.pool.run(payload)

        if (response.error) {
          throw Object.assign(new Error(response.error.message), { stack: response.error.stack })
        }

        return response.data ?? {}
      }

      return await convertToIstanbul(payload)
    }
    catch (error) {
      this.ctx.logger.error(`Failed to parse ${filename}. Excluding it from coverage.\n`, error)
      return {}
    }
  }

  private async getSources(
    url: string,
    onTransform: (filepath: string, isExtendedContext?: ScriptCoverageWithOffset['isExtendedContext']) => Promise<Vite.TransformResult | undefined | null>,
    functions: Profiler.FunctionCoverage[] = [],
    isExtendedContext: ScriptCoverageWithOffset['isExtendedContext'] = false,
  ): Promise<{
    code: string
    map?: Vite.Rollup.SourceMap
  }> {
    // TODO: need to standardize file urls before this call somehow, this is messy
    const filepath = url.match(/^file:\/\/\/\w:\//)
      ? url.slice(8)
      : removeStartsWith(url, FILE_PROTOCOL)
    // TODO: do we still need to "catch" here? why would it fail?
    const transformResult = await onTransform(filepath, isExtendedContext).catch(() => null)

    const map = transformResult?.map as Vite.Rollup.SourceMap | undefined
    const code = transformResult?.code

    if (code == null) {
      const filePath = normalize(fileURLToPath(url))

      const original = await fs.readFile(filePath, 'utf-8').catch(() => {
        // If file does not exist construct a dummy source for it.
        // These can be files that were generated dynamically during the test run and were removed after it.
        const length = findLongestFunctionLength(functions)
        return '/'.repeat(length)
      })

      return { code: original }
    }

    // Vue needs special handling for "map.sources"
    if (map) {
      map.sources ||= []

      map.sources = map.sources
        .filter(source => source != null)
        .map(source => new URL(source, url).href)

      if (map.sources.length === 0) {
        map.sources.push(url)
      }
    }

    return { code, map }
  }

  private async convertCoverage(
    coverage: RawCoverage,
    project: TestProject = this.ctx.getRootProject(),
    environment: string,
  ): Promise<CoverageMap> {
    if (environment === '__browser__' && !project.browser) {
      throw new Error(`Cannot access browser module graph because it was torn down.`)
    }

    const onTransform = async (filepath: string, isExtendedContext: ScriptCoverageWithOffset['isExtendedContext'] = false) => {
      const result = await this.transformFile(filepath, project, environment, !isExtendedContext)
      if (result && environment === '__browser__' && project.browser) {
        return { ...result, code: `${result.code}// <inline-source-map>` }
      }
      return result
    }

    const scriptCoverages = []

    for (const result of coverage.result) {
      if (environment === '__browser__') {
        if (result.url.startsWith('/@fs')) {
          result.url = `${FILE_PROTOCOL}${removeStartsWith(result.url, '/@fs')}`
        }
        else if (result.url.startsWith(project.config.root)) {
          result.url = `${FILE_PROTOCOL}${result.url}`
        }
        else {
          result.url = `${FILE_PROTOCOL}${project.config.root}${result.url}`
        }
      }

      if (this.isIncluded(fileURLToPath(result.url))) {
        scriptCoverages.push({ ...result, url: decodeURIComponent(result.url) })
      }
    }

    this.ensurePool(scriptCoverages.length)

    const coverageMap = this.createCoverageMap()
    let index = 0

    for (const chunk of this.toSlices(scriptCoverages, this.options.processingConcurrency)) {
      if (debug.enabled) {
        index += chunk.length
        debug('Converting %d/%d', index, scriptCoverages.length)
      }

      await Promise.all(
        chunk.map(async ({ url, functions, startOffset, isExtendedContext }) => {
          let timeout: ReturnType<typeof setTimeout> | undefined
          let start: number | undefined

          if (debug.enabled) {
            start = performance.now()
            timeout = setTimeout(() => debug(c.bgRed(`File "${fileURLToPath(url)}" is taking longer than 3s`)), 3_000)
          }

          const sources = await this.getSources(
            url,
            onTransform,
            functions,
            isExtendedContext,
          )

          coverageMap.merge(await this.remapCoverage(
            url,
            startOffset,
            sources,
            functions,
          ))

          if (debug.enabled) {
            clearTimeout(timeout)

            const diff = performance.now() - start!
            const color = diff > 500 ? c.bgRed : c.bgGreen
            debug(`${color(` ${diff.toFixed()} ms `)} ${fileURLToPath(url)}`)
          }
        }),
      )
    }

    return coverageMap
  }
}

/**
 * Find the function with highest `endOffset` to determine the length of the file
 */
function findLongestFunctionLength(functions: Profiler.FunctionCoverage[]) {
  return functions.reduce((previous, current) => {
    const maxEndOffset = current.ranges.reduce(
      (endOffset, range) => Math.max(endOffset, range.endOffset),
      0,
    )

    return Math.max(previous, maxEndOffset)
  }, 0)
}

function removeStartsWith(filepath: string, start: string) {
  if (filepath.startsWith(start)) {
    return filepath.slice(start.length)
  }

  return filepath
}
