import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// iOS keyboard viewport fix: resize layout instead of overlapping
function syncAppHeight() {
  const vh = window.visualViewport?.height ?? window.innerHeight
  document.documentElement.style.setProperty('--app-height', `${vh}px`)
}
syncAppHeight()
window.visualViewport?.addEventListener('resize', syncAppHeight)
window.visualViewport?.addEventListener('scroll', () => {
  // Prevent iOS from scrolling the viewport when keyboard appears
  if (window.visualViewport && window.visualViewport.offsetTop > 0) {
    window.scrollTo(0, 0)
  }
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
