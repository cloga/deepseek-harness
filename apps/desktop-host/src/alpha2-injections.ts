/** Preflight the official Webserver's owned JSON injection rows before private IPC. */
import { renderIndexInjections, type IndexInjection } from '@deepseek-ai/dsh-host-webserver'

export const MAX_ALPHA2_INJECTION_BYTES = 4 * 1024 * 1024

/**
 * Reject circular, malformed, or oversized rows with a fixed diagnostic.
 * The Webserver already serializes these same rows when serving index.html;
 * this validation never prints their source or token-bearing values.
 */
export function assertAlpha2Injections(rows: readonly IndexInjection[]): void {
  if (rows.length > 4096) throw new Error('desktop alpha2: client module table exceeds its bound')
  let html: string
  try { html = renderIndexInjections('<html><head></head><body></body></html>', rows) }
  catch { throw new Error('desktop alpha2: client module table is invalid') }
  if (Buffer.byteLength(html, 'utf8') > MAX_ALPHA2_INJECTION_BYTES) {
    throw new Error('desktop alpha2: client module table exceeds its byte bound')
  }
}
