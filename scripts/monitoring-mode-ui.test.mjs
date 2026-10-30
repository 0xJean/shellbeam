import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chooseServerMonitoring } from './monitoring-mode-ui.mjs'
function driver({ vault = 'fixture', confirmedVault = vault, message = 'Choose ShellBeam Server monitoring? installation requires separate confirmation.' } = {}) {
  let open = false, selected = false, install = true
  const clicks = []
  return { clicks, waitFor: async () => {}, attr: async (s,k) => k === 'data-risk' ? 'low' : s.includes('user-confirmation') ? confirmedVault : vault,
    isSelected: async s => s.includes('install-probe') ? install : s.includes('mode-ssh') ? !selected : selected,
    click: async s => { clicks.push(s); if(s.includes('install-probe')) install = false; else if(s.includes('user-confirmation-accept')) { selected = true; open = false } else open = true },
    findAll: async () => open ? ['dialog'] : [], text: async () => message,
    until: async predicate => assert(await predicate()) }
}
test('monitoring onboarding explicitly reviews the SSH default before Server opt-in', async () => {
  const d = driver(); await chooseServerMonitoring(d)
  assert.equal(d.clicks.length, 3)
  assert(d.clicks[0].includes('monitoring-mode-server'))
  assert(d.clicks[1].includes('user-confirmation-accept'))
  assert(d.clicks[2].includes('host-form-install-probe'))
})
for(const [name, config] of [['missing vault',{vault:''}],['changed vault',{confirmedVault:'other'}],['unrelated review',{message:'Install now'}]]) {
  test(`monitoring onboarding refuses ${name} without accepting or installing`, async () => {
    const d = driver(config); await assert.rejects(chooseServerMonitoring(d))
    assert(!d.clicks.some(s => s.includes('user-confirmation-accept')))
  })
}
