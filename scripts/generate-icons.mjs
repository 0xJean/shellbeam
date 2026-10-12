import { execFileSync } from 'node:child_process'
import { copyFileSync, cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const output = mkdtempSync(join(tmpdir(), 'shellbeam-icons-'))

// App Store Connect requires the large iOS icon to be fully opaque. Keep the
// desktop icons transparent, but composite the generated iOS set over the
// product's dark tile before copying it into the Xcode asset catalog.
const flattenIosIcon = (file) => {
  if (process.platform !== 'darwin') return
  execFileSync('/usr/bin/swift', ['-module-cache-path', join(output, 'swift-cache'), '-e', `
import CoreGraphics
import ImageIO
import Foundation

let input = CommandLine.arguments[1]
let output = CommandLine.arguments[2]
guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: input) as CFURL, nil),
      let image = CGImageSourceCreateImageAtIndex(source, 0, nil),
      let context = CGContext(
  data: nil,
  width: image.width,
  height: image.height,
  bitsPerComponent: 8,
  bytesPerRow: 0,
  space: CGColorSpaceCreateDeviceRGB(),
  bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
) else { fatalError("Unable to create RGB icon context") }
let rect = CGRect(x: 0, y: 0, width: image.width, height: image.height)
context.setFillColor(red: 7.0 / 255.0, green: 11.0 / 255.0, blue: 16.0 / 255.0, alpha: 1)
context.fill(rect)
context.draw(image, in: rect)
guard let flattened = context.makeImage(),
      let destination = CGImageDestinationCreateWithURL(URL(fileURLWithPath: output) as CFURL, "public.png" as CFString, 1, nil)
else { fatalError("Unable to encode icon") }
CGImageDestinationAddImage(destination, flattened, nil)
guard CGImageDestinationFinalize(destination) else { fatalError("Unable to write icon") }
`, file, file], { cwd: root, stdio: 'inherit' })
}

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
  for (const entry of readdirSync(join(output, 'ios'), { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.png')) {
      flattenIosIcon(join(root, 'src-tauri/gen/apple/Assets.xcassets/AppIcon.appiconset', entry.name))
    }
  }
  copyFileSync(join(output, 'icon.png'), join(root, 'src/assets/logo.png'))
  copyFileSync(join(output, '32x32.png'), join(root, 'public/favicon.png'))
} finally {
  rmSync(output, { recursive: true, force: true })
}
