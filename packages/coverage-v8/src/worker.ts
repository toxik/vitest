import type { CoverageMapData } from 'istanbul-lib-coverage'
import type { RemapCoveragePayload } from './to-istanbul'
import { convertToIstanbul } from './to-istanbul'

export interface RemapWorkerResult {
  data?: CoverageMapData
  error?: { message: string; stack?: string }
}

/**
 * Tinypool worker entry. Runs the CPU-bound V8 -> Istanbul conversion off the
 * main thread. Errors are returned as serializable data because the worker has
 * no access to the main-thread logger.
 */
export default async function remapCoverage(payload: RemapCoveragePayload): Promise<RemapWorkerResult> {
  try {
    const data = await convertToIstanbul(payload)
    return { data }
  }
  catch (error) {
    return {
      error: {
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      },
    }
  }
}
