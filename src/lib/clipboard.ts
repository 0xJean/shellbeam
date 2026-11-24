/**
 * Copies text to the system clipboard with an execCommand fallback for WebView
 * environments where `navigator.clipboard.writeText` can reject.
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (!text) return false
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.clipboard?.writeText === 'function') {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // Fall through to legacy textarea selection copy below.
  }
  if (typeof document === 'undefined') return false
  try {
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.setAttribute('readonly', '')
    textarea.style.position = 'fixed'
    textarea.style.top = '-9999px'
    textarea.style.left = '-9999px'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.focus()
    textarea.select()
    textarea.setSelectionRange(0, text.length)
    const ok = typeof document.execCommand === 'function' ? document.execCommand('copy') : false
    textarea.remove()
    return ok
  } catch {
    return false
  }
}
