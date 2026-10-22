import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import JSZip from 'jszip'
const root = new URL('../', import.meta.url)
const zip = new JSZip()
for (const file of ['komari-plugin.json', 'policy.cjs', 'server.cjs']) zip.file(file, await readFile(new URL(`monitoring-extension/${file}`, root)), { date: new Date('2026-01-01T00:00:00Z'), unixPermissions: 0o100644 })
const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE', platform: 'UNIX' })
const target = new URL('src-tauri/resources/monitoring-extension.zip', root)
if (process.argv.includes('--check')) {
  if (!(await readFile(target)).equals(bytes)) throw Error('Bundled monitoring extension differs from reviewed sources')
} else await writeFile(fileURLToPath(target), bytes)
