/**
 * Validated provider-private fields from an OpenAI Responses-compatible response.
 * @module @deepseek-ai/dsh-web-search-openai-responses/types
 */

/** Structured source metadata accepted from search actions and URL citations. */
export interface StructuredSource {
  /** Absolute HTTP(S) URL. */
  readonly url: string
  /** Provider-supplied page title. */
  readonly title?: string
  /** Provider-supplied excerpt. */
  readonly snippet?: string
}

/** Validated fields consumed from one `output_text` content item. */
export interface OutputText {
  /** Final generated text. */
  readonly text: string
  /** Structured URL citations in provider order. */
  readonly citations: readonly StructuredSource[]
}

/** Validated subset of one Responses API output item. */
export type ResponsesOutput =
  | { readonly type: 'web_search_call'; readonly sources: readonly StructuredSource[] }
  | { readonly type: 'message'; readonly texts: readonly OutputText[] }
  | { readonly type: 'other' }

/** Validated subset of a Responses API success envelope. */
export interface OpenAiResponsesPayload {
  /** Provider output items in wire order. */
  readonly output: readonly ResponsesOutput[]
}
