import assert from 'node:assert/strict'
const id = value => `[data-testid="${value}"]`
const field = id('monitoring-mode-field')

/** Streamlined opt-in for Server monitoring in HostForm without modal interruption. */
export async function chooseServerMonitoring(driver) {
  await driver.waitFor(field)
  const vaultId = await driver.attr(field, 'data-vault-id')
  assert(typeof vaultId === 'string' && vaultId.length > 0, 'monitoring_choice_vault_missing')
  assert(await driver.isSelected(id('monitoring-mode-ssh')), 'monitoring_choice_default_not_ssh')
  assert(!await driver.isSelected(id('monitoring-mode-server')), 'monitoring_choice_already_selected')
  await driver.click(id('monitoring-mode-server'))
  await driver.until(async () => await driver.isSelected(id('monitoring-mode-server')) && !await driver.isSelected(id('monitoring-mode-ssh')))
  // Saving would otherwise open the probe installer over the host list; the
  // journeys bind and install through their own reviewed steps.
  const installOnSave = `${id('host-form-install-probe')} input[type="checkbox"]`
  if (await driver.isSelected(installOnSave)) await driver.click(installOnSave)
  assert(!await driver.isSelected(installOnSave), 'monitoring_choice_install_on_save_not_cleared')
}
