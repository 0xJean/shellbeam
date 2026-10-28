/**
 * The terminal's right sidebar lives outside the terminal view. These events
 * let its search button toggle the active session's search bar and reflect
 * whether that bar is open.
 */
export const TERMINAL_SEARCH_TOGGLE_EVENT = 'shellbeam:terminal-search-toggle'
export const TERMINAL_SEARCH_STATE_EVENT = 'shellbeam:terminal-search-state'

export function requestTerminalSearchToggle(sessionId: string) {
  window.dispatchEvent(new CustomEvent<{ sessionId: string }>(TERMINAL_SEARCH_TOGGLE_EVENT, { detail: { sessionId } }))
}

export function announceTerminalSearchState(sessionId: string, open: boolean) {
  window.dispatchEvent(new CustomEvent<{ sessionId: string; open: boolean }>(TERMINAL_SEARCH_STATE_EVENT, { detail: { sessionId, open } }))
}

export const TERMINAL_AI_TOGGLE_EVENT = 'shellbeam:terminal-ai-toggle'
export const TERMINAL_AI_STATE_EVENT = 'shellbeam:terminal-ai-state'

export function requestTerminalAiToggle(sessionId: string) {
  window.dispatchEvent(new CustomEvent<{ sessionId: string }>(TERMINAL_AI_TOGGLE_EVENT, { detail: { sessionId } }))
}

/** Lets the top-bar AI button show whether the session's AI bar is open. */
export function announceTerminalAiState(sessionId: string, open: boolean) {
  window.dispatchEvent(new CustomEvent<{ sessionId: string; open: boolean }>(TERMINAL_AI_STATE_EVENT, { detail: { sessionId, open } }))
}
