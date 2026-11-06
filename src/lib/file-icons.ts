/**
 * Which file-type glyph a directory entry shows: whole names first
 * (`Dockerfile`, `README.md`, `.gitignore`), then the extension, then a
 * plain file. Glyphs are Material Icon Theme's (MIT), see
 * `src/assets/file-icons/LICENSE`.
 */

export type FileIconName =
  | 'folder' | 'file' | 'javascript' | 'typescript' | 'react' | 'react_ts' | 'json' | 'yaml' | 'toml' | 'xml'
  | 'markdown' | 'readme' | 'license' | 'docker' | 'git' | 'console' | 'powershell' | 'settings' | 'makefile'
  | 'tune' | 'lock' | 'log' | 'image' | 'svg' | 'pdf' | 'zip' | 'audio' | 'video' | 'table' | 'database'
  | 'python' | 'go' | 'rust' | 'java' | 'kotlin' | 'c' | 'cpp' | 'h' | 'csharp' | 'php' | 'ruby' | 'swift'
  | 'lua' | 'html' | 'css' | 'sass' | 'vue' | 'nginx' | 'npm' | 'key' | 'certificate' | 'exe' | 'font'
  | 'document' | 'word' | 'terraform' | 'editorconfig'

const byExtension: Record<string, FileIconName> = {}
const extensions = (icon: FileIconName, ...list: string[]) => { for (const ext of list) byExtension[ext] = icon }
extensions('javascript', 'js', 'mjs', 'cjs')
extensions('typescript', 'ts', 'mts', 'cts')
extensions('react', 'jsx')
extensions('react_ts', 'tsx')
extensions('json', 'json', 'jsonc', 'json5', 'ndjson')
extensions('yaml', 'yaml', 'yml')
extensions('toml', 'toml')
extensions('xml', 'xml', 'plist', 'xsd', 'xsl')
extensions('markdown', 'md', 'markdown', 'mdx')
extensions('console', 'sh', 'bash', 'zsh', 'fish', 'ksh', 'bat', 'cmd', 'command')
extensions('powershell', 'ps1', 'psm1', 'psd1')
extensions('settings', 'conf', 'cfg', 'ini', 'properties', 'service', 'timer', 'socket')
extensions('tune', 'env')
extensions('lock', 'lock')
extensions('log', 'log', 'out')
extensions('image', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'heic', 'avif', 'tif', 'tiff')
extensions('svg', 'svg')
extensions('pdf', 'pdf')
extensions('zip', 'zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'zst', '7z', 'rar', 'jar', 'war', 'deb', 'rpm', 'dmg', 'iso', 'apk')
extensions('audio', 'mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'opus')
extensions('video', 'mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v', 'flv')
extensions('table', 'csv', 'tsv', 'xls', 'xlsx', 'ods')
extensions('database', 'sql', 'db', 'sqlite', 'sqlite3', 'dump')
extensions('python', 'py', 'pyi', 'pyw')
extensions('go', 'go')
extensions('rust', 'rs')
extensions('java', 'java', 'class', 'gradle')
extensions('kotlin', 'kt', 'kts')
extensions('c', 'c')
extensions('cpp', 'cc', 'cpp', 'cxx', 'hpp', 'hh')
extensions('h', 'h')
extensions('csharp', 'cs')
extensions('php', 'php')
extensions('ruby', 'rb', 'gemspec')
extensions('swift', 'swift')
extensions('lua', 'lua')
extensions('html', 'html', 'htm', 'xhtml')
extensions('css', 'css', 'less')
extensions('sass', 'scss', 'sass')
extensions('vue', 'vue')
extensions('key', 'key', 'pub', 'pem', 'ppk', 'gpg', 'asc', 'p8')
extensions('certificate', 'crt', 'cer', 'csr', 'p12', 'pfx', 'der')
extensions('exe', 'exe', 'msi', 'app', 'bin', 'run', 'appimage')
extensions('font', 'ttf', 'otf', 'woff', 'woff2')
extensions('document', 'txt', 'rtf', 'rst', 'tex', 'odt')
extensions('word', 'doc', 'docx')
extensions('terraform', 'tf', 'tfvars')

const byName: Record<string, FileIconName> = {
  dockerfile: 'docker', 'docker-compose.yml': 'docker', 'docker-compose.yaml': 'docker',
  'compose.yml': 'docker', 'compose.yaml': 'docker', '.dockerignore': 'docker',
  '.gitignore': 'git', '.gitattributes': 'git', '.gitmodules': 'git', '.gitconfig': 'git', '.gitkeep': 'git',
  license: 'license', 'license.md': 'license', 'license.txt': 'license', licence: 'license', copying: 'license',
  readme: 'readme', 'readme.md': 'readme', 'readme.txt': 'readme', 'readme.rst': 'readme',
  makefile: 'makefile', gnumakefile: 'makefile',
  'package.json': 'npm', 'package-lock.json': 'npm', '.npmrc': 'npm',
  'nginx.conf': 'nginx', '.editorconfig': 'editorconfig',
  '.bashrc': 'console', '.zshrc': 'console', '.profile': 'console', '.bash_profile': 'console',
  authorized_keys: 'key', known_hosts: 'key', id_rsa: 'key', id_ed25519: 'key', id_ecdsa: 'key',
  crontab: 'settings', '.prettierrc': 'settings', '.eslintrc': 'settings',
}

export function fileIconName(fileName: string, isDir: boolean): FileIconName {
  if (isDir) return 'folder'
  const name = fileName.toLowerCase()
  if (byName[name]) return byName[name]
  // `.env`, `.env.production`, `.env.example`
  if (name === '.env' || name.startsWith('.env.')) return 'tune'
  if (name.startsWith('dockerfile.') || name.endsWith('.dockerfile')) return 'docker'
  const dot = name.lastIndexOf('.')
  if (dot > 0 && dot < name.length - 1) return byExtension[name.slice(dot + 1)] ?? 'file'
  return 'file'
}
