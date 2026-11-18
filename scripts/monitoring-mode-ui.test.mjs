import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chooseServerMonitoring } from './monitoring-mode-ui.mjs'

function driver({ vault = 'fixture' } = {}) {
  let selected = false, install = true
  const clicks = []
  return {
    clicks,
    waitFor: async () => {},
    attr: async () => vault,
    isSelected: async s => s.includes('install-probe') ? install : s.includes('mode-ssh') ? !selected : selected,
    click: async s => {
      clicks.push(s)
      if (s.includes('install-probe')) install = false
      else if (s.includes('monitoring-mode-server')) selected = !selected
    },
    until: async predicate => assert(await predicate()),
  }
}

test('monitoring onboarding enables Server monitoring directly without blocking popups', async () => {
  const d = driver()
  await chooseServerMonitoring(d)
  assert.equal(d.clicks.length, 2)
  assert(d.clicks[0].includes('monitoring-mode-server'))
  assert(d.clicks[1].includes('host-form-install-probe'))
})

test('monitoring onboarding refuses missing vault without enabling Server monitoring', async () => {
  const d = driver({ vault: '' })
  await assert.rejects(chooseServerMonitoring(d))
  assert(!d.clicks.some(s => s.includes('monitoring-mode-server')))
})
