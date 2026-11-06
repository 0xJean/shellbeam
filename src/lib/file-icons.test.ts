import { describe, expect, it } from 'vitest'
import { fileIconName } from './file-icons'

describe('fileIconName', () => {
  it('recognises whole names before extensions', () => {
    expect(fileIconName('Dockerfile', false)).toBe('docker')
    expect(fileIconName('compose.yaml', false)).toBe('docker')
    expect(fileIconName('README.md', false)).toBe('readme')
    expect(fileIconName('LICENSE', false)).toBe('license')
    expect(fileIconName('.gitignore', false)).toBe('git')
    expect(fileIconName('Makefile', false)).toBe('makefile')
    expect(fileIconName('package.json', false)).toBe('npm')
    expect(fileIconName('authorized_keys', false)).toBe('key')
  })

  it('maps env files, extensions and unknowns', () => {
    expect(fileIconName('.env.production', false)).toBe('tune')
    expect(fileIconName('deploy.sh', false)).toBe('console')
    expect(fileIconName('ecosystem.config.js', false)).toBe('javascript')
    expect(fileIconName('CHANGELOG.md', false)).toBe('markdown')
    expect(fileIconName('backup.tar.gz', false)).toBe('zip')
    expect(fileIconName('nginx.conf', false)).toBe('nginx')
    expect(fileIconName('VERSION', false)).toBe('file')
    expect(fileIconName('.hidden', false)).toBe('file')
    expect(fileIconName('trailing.', false)).toBe('file')
  })

  it('shows every directory as a folder, whatever its name', () => {
    expect(fileIconName('logs.json', true)).toBe('folder')
  })
})
