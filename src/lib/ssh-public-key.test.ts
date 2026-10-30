import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { AUTHORIZED_KEY_ADDED, AUTHORIZED_KEY_PRESENT, buildAuthorizedKeysAppendCommand, openSshFingerprint, parseOpenSshPublicKey } from './ssh-public-key'

const ed25519 = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGakgi4tyu+8n90xMy1obL1HlJ6AD0VDPDILB4PLW7EW jean's key"
const rsa = 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQCvFqwmX5+P5tFhM/h6+5To9GiKOvfAkjf+vlrjlRd21EVe8CHe7lgUIbTgsCYrvAYvErF7A3ZV7XMELUMTGOJKmfDJupJIz6JpSgh+T5kYVG8Frg1kP25gZXiRfjDpOGZzkAuHM0niLY0zGa+knmYK6BPjS4A00IFxNsnsuyhDRlLBaiGXLwjlhJDXFXpRSygstBb/FUnBHtrvLlB3o8nd7ZW60ySzpW6IWmzi0r5C2VFaZ8MsGgRrVO5GQQpBCYFfvf7HlwNx1paQ2N3RVrBWJ5DVxC2YGmFRIlLNiMFfWGRI5zwDAB9MHnmas84e/vOCv3C9FrhdSf4aLeTT7KL+Gl2qKKuO4pS9jJYgnwOHj3YWPm7vc8LAaiamGW5BPYK1TS/2T/sLoN8SdlRG/nKef77YuyUNR5/FXVHn0KiFVU0w29BAVVMEo2QGCRipVi/yZHVsC/8yQWnomuxyZdDDJPHIlc6pSdDKnrx0QvwWQdg7tJN8URE9mBnijer+VCE= r'
const ecdsa = 'ecdsa-sha2-nistp384 AAAAE2VjZHNhLXNoYTItbmlzdHAzODQAAAAIbmlzdHAzODQAAABhBMMOAoctKA7+6MCBN/bmx9bvx2TwP+kFXaT8j32D5VGaZqbCmGsCIA4ge1qQR1Sc3F0Z5lg7JaSZuRn0W5O2n5buwxIJ1lfSlpxDbMGc0u0S1z1Hy4SxqgE5cfNJdHgHOQ== e'

describe('OpenSSH public keys', () => {
  it('parses algorithm, comment and the ssh-keygen fingerprint', async () => {
    const key = parseOpenSshPublicKey(`${ed25519}\n`)!
    expect(key).toMatchObject({ type: 'ssh-ed25519', comment: "jean's key", algorithm: 'ED25519', line: ed25519 })
    expect(await openSshFingerprint(key)).toBe('SHA256:33Ck/m3aTl9chTNTUpTStjBG7O+wFsrwPnZIPsLTAPg')
    expect(parseOpenSshPublicKey(rsa)?.algorithm).toBe('RSA 3072')
    expect(await openSshFingerprint(parseOpenSshPublicKey(rsa)!)).toBe('SHA256:RzTSm1ds3hIakcb3Curj83Ym14mcflTuqGW6wS9Dspk')
    expect(parseOpenSshPublicKey(ecdsa)?.algorithm).toBe('ECDSA 384')
  })

  it('rejects private key material, multi-line values and mismatched blobs', () => {
    expect(parseOpenSshPublicKey('-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----')).toBeNull()
    expect(parseOpenSshPublicKey(`${ed25519}\n${ed25519}`)).toBeNull()
    expect(parseOpenSshPublicKey(ed25519.replace('ssh-ed25519', 'ssh-rsa'))).toBeNull()
    expect(parseOpenSshPublicKey('secret-value')).toBeNull()
  })

  it.skipIf(process.platform === 'win32')('appends to authorized_keys once and keeps unrelated lines', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'sb-authkeys-'))
    try {
      const run = (line: string) => execFileSync('/bin/sh', ['-c', buildAuthorizedKeysAppendCommand(parseOpenSshPublicKey(line)!)], { env: { ...process.env, HOME: home }, encoding: 'utf8' }).trim()
      expect(run(ed25519)).toBe(AUTHORIZED_KEY_ADDED)
      expect(run(ed25519.replace("jean's key", 'renamed'))).toBe(AUTHORIZED_KEY_PRESENT)
      const file = path.join(home, '.ssh', 'authorized_keys')
      writeFileSync(file, `${readFileSync(file, 'utf8')}command="x" ${ecdsa.split(' ').slice(0, 2).join(' ')}`)
      expect(run(ecdsa)).toBe(AUTHORIZED_KEY_PRESENT)
      expect(run(rsa)).toBe(AUTHORIZED_KEY_ADDED)
      expect(readFileSync(file, 'utf8').split('\n')).toEqual([ed25519, `command="x" ${ecdsa.split(' ').slice(0, 2).join(' ')}`, rsa, ''])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')('creates authorized_keys without changing an existing ~/.ssh mode', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'sb-authkeys-'))
    try {
      mkdirSync(path.join(home, '.ssh'), { mode: 0o755 })
      execFileSync('/bin/sh', ['-c', buildAuthorizedKeysAppendCommand(parseOpenSshPublicKey(ed25519)!)], { env: { ...process.env, HOME: home } })
      expect(readFileSync(path.join(home, '.ssh', 'authorized_keys'), 'utf8')).toBe(`${ed25519}\n`)
      expect(statSync(path.join(home, '.ssh')).mode & 0o777).toBe(0o755)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
