import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import JSZip from 'jszip'
import { createHash } from 'node:crypto'
const root = new URL('../', import.meta.url)
// These immutable bytes are the only legacy package eligible for native recovery.
const legacy = {'komari-plugin.json': 'ea484db50fb913cf337c870d726c1997dfe52a74e2508491ce435079633c355b', 'policy.cjs': '697e8c776462b50ac9e824bd5c8aa05a23cb223ccbb65aec684182ad8a64c25f', 'server.cjs': 'e86a41ff27c6736c358359df9f6da81948be6ebcabf5032d0f8a80602cfe3e8f' }
for (const [file, digest] of Object.entries(legacy)) {
  const bytes = await readFile(new URL(`monitoring-extension/releases/0.1.0/${file}`, root))
  if (createHash('sha256').update(bytes).digest('hex') !== digest) throw Error('Retained legacy extension changed')
}
const zip = new JSZip()
for (const file of ['komari-plugin.json', 'policy.cjs', 'server.cjs']) zip.file(file, await readFile(new URL(`monitoring-extension/${file}`, root)), { date: new Date('2026-01-01T00:00:00Z'), unixPermissions: 0o100644 })
const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE', platform: 'UNIX' })
const target = new URL('src-tauri/resources/monitoring-extension.zip', root)
if (process.argv.includes('--check')) {
  if (!(await readFile(target)).equals(bytes)) throw Error('Bundled monitoring extension differs from reviewed sources')
} else await writeFile(fileURLToPath(target), bytes)
