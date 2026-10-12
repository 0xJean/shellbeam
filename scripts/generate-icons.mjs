import { execFileSync } from 'node:child_process'
import { copyFileSync, cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const output = mkdtempSync(join(tmpdir(), 'shellbeam-icons-'))

try {
  execFileSync(process.execPath, [
    join(root, 'node_modules/@tauri-apps/cli/tauri.js'),
    'icon', join(root, 'app-icon.png'),
    '--output', output,
    '--ios-color', '#070B10',
  ], { cwd: root, stdio: 'inherit' })

  for (const entry of readdirSync(output, { withFileTypes: true })) {
    if (entry.isFile()) {
      copyFileSync(join(output, entry.name), join(root, 'src-tauri/icons', entry.name))
    }
  }

  // Preserve native project configuration while updating generated icon resources.
  cpSync(join(output, 'android'), join(root, 'src-tauri/gen/android/app/src/main/res'), { recursive: true })
  cpSync(join(output, 'ios'), join(root, 'src-tauri/gen/apple/Assets.xcassets/AppIcon.appiconset'), { recursive: true })
  copyFileSync(join(output, 'icon.png'), join(root, 'src/assets/logo.png'))
  copyFileSync(join(output, '32x32.png'), join(root, 'public/favicon.png'))
} finally {
  rmSync(output, { recursive: true, force: true })
}
