import assert from 'node:assert/strict'
const id = value => `[data-testid="${value}"]`
const field = id('monitoring-mode-field')
const confirmation = `dialog[open] ${id('user-confirmation')}`

/** Real opt-in before a new host can join a monitoring service. No IPC or
 * credentials are read here; all subsequent binding/install reviews still run. */
export async function chooseServerMonitoring(driver) {
  await driver.waitFor(field)
  const vaultId = await driver.attr(field, 'data-vault-id')
  assert(typeof vaultId === 'string' && vaultId.length > 0, 'monitoring_choice_vault_missing')
  assert(await driver.isSelected(id('monitoring-mode-ssh')), 'monitoring_choice_default_not_ssh')
  assert(!await driver.isSelected(id('monitoring-mode-server')), 'monitoring_choice_already_selected')
  await driver.click(id('monitoring-mode-server'))
  await driver.waitFor(confirmation)
  const dialogs = await driver.findAll(confirmation)
  assert.equal(dialogs.length, 1, 'monitoring_choice_confirmation_ambiguous')
  assert.equal(await driver.attr(confirmation, 'data-vault-id'), vaultId, 'monitoring_choice_vault_changed')
  assert.equal(await driver.attr(confirmation, 'data-risk'), 'low', 'monitoring_choice_wrong_review')
  const message = await driver.text(`${confirmation} ${id('user-confirmation-message')}`)
  assert(message.includes('Choose ShellBeam Server monitoring?') && message.includes('installation requires separate confirmation.'), 'monitoring_choice_message_mismatch')
  assert(!await driver.isSelected(id('monitoring-mode-server')), 'monitoring_choice_changed_before_consent')
  await driver.click(`${confirmation} ${id('user-confirmation-accept')}`)
  await driver.until(async () => !(await driver.findAll(confirmation)).length)
  await driver.until(async () => await driver.isSelected(id('monitoring-mode-server')) && !await driver.isSelected(id('monitoring-mode-ssh')))
  // Saving would otherwise open the probe installer over the host list; the
  // journeys bind and install through their own reviewed steps.
  const installOnSave = `${id('host-form-install-probe')} input[type="checkbox"]`
  if (await driver.isSelected(installOnSave)) await driver.click(installOnSave)
  assert(!await driver.isSelected(installOnSave), 'monitoring_choice_install_on_save_not_cleared')
}
