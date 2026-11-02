import { describe, expect, it } from 'vitest'
import { localDownloadPath } from './sftp'

describe('localDownloadPath', () => {
  it('joins an ordinary name to the folder', () => {
    expect(localDownloadPath('/home/me', 'a b.txt')).toBe('/home/me/a b.txt')
    expect(localDownloadPath('/home/me/', '..hidden')).toBe('/home/me/..hidden')
  })

  it.each(['', '.', '..', '../../Library/LaunchAgents/x.plist', 'a/b', 'a\\b', '..\\x', 'C:evil', 'x\u0000y', 'x\ny'])(
    'refuses %j',
    (name) => {
      expect(() => localDownloadPath('/home/me', name)).toThrow(/unsafe file name/)
    },
  )
})
