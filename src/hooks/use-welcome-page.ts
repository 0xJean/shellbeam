import { useCallback, useState } from 'react'

const WELCOME_KEY = 'shellbeam.welcomeSeen'

export function useWelcomePage() {
  const [show, setShow] = useState(() => {
    try { return !localStorage.getItem(WELCOME_KEY) } catch { return true }
  })
  const dismiss = useCallback(() => {
    try { localStorage.setItem(WELCOME_KEY, '1') } catch { /* Still allow entry when storage is unavailable. */ }
    setShow(false)
  }, [])
  return { show, dismiss }
}
