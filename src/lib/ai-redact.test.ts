import { describe, expect, it, vi } from 'vitest'
import { REDACTED, redactSecrets } from './ai-redact'

describe('redactSecrets', () => {
  it('drops the body of private keys and keeps the armour', () => {
    const key = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\nAAAABG5vbmU=\n-----END OPENSSH PRIVATE KEY-----'
    const out = redactSecrets(`$ cat id_ed25519\n${key}\n$ `)
    expect(out).toContain('-----BEGIN OPENSSH PRIVATE KEY-----')
    expect(out).toContain('-----END OPENSSH PRIVATE KEY-----')
    expect(out).not.toContain('b3BlbnNzaC1rZXktdjEAAAAA')
  })

  it('masks a private key cut off by the end of the captured output', () => {
    expect(redactSecrets('-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA')).not.toContain('MIIEowIBAAKCAQEA')
  })

  it('masks credentials inside URLs but keeps the user and host', () => {
    expect(redactSecrets('DATABASE_URL=postgres://app:s3cr3t@db:5432/app')).not.toContain('s3cr3t')
    expect(redactSecrets('git clone https://deploy:ghtoken123@github.com/org/repo')).toBe(`git clone https://deploy:${REDACTED}@github.com/org/repo`)
  })

  it('masks bearer tokens and well-known token formats', () => {
    expect(redactSecrets('Authorization: Bearer abcdefghijklmnop.qrstu')).toBe(`Authorization: Bearer ${REDACTED}`)
    for (const token of [
      'sk-proj-abcdefghijklmnopqrstuvwxyz012345',
      'sk-ant-api03-abcdefghijklmnopqrstuvwxyz',
      'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      'AKIAIOSFODNN7EXAMPLE',
      'xoxb-1234567890-abcdefghij',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV',
    ]) expect(redactSecrets(`value ${token} end`)).toBe(`value ${REDACTED} end`)
  })

  it('masks secret assignments, fields and flags but keeps their names', () => {
    expect(redactSecrets('export DB_PASSWORD=hunter2')).toBe(`export DB_PASSWORD=${REDACTED}`)
    expect(redactSecrets('MYSQL_ROOT_PASSWORD="hunter 2"')).toBe(`MYSQL_ROOT_PASSWORD="${REDACTED}"`)
    expect(redactSecrets('{"api_key": "abc123", "region": "eu"}')).toBe(`{"api_key": "${REDACTED}", "region": "eu"}`)
    expect(redactSecrets('client_secret: abc123')).toBe(`client_secret: ${REDACTED}`)
    expect(redactSecrets('mysql --password=hunter2 -h db')).toBe(`mysql --password=${REDACTED} -h db`)
    expect(redactSecrets('vault login --token s.abcdef')).toBe(`vault login --token ${REDACTED}`)
    expect(redactSecrets('sshpass -p hunter2 ssh root@h')).toBe(`sshpass -p ${REDACTED} ssh root@h`)
  })

  it('leaves ordinary output alone', () => {
    const text = [
      'PWD=/home/deploy', 'OLDPWD=/tmp', 'root:x:0:0:root:/root:/bin/bash',
      'cat /etc/passwd', 'Filesystem Size Used Avail Use%', 'token_type: bearer',
      'AuthMethod=publickey', 'deploy@web-01:~$ ls -la', 'https://example.com/path?q=1',
    ].join('\n')
    expect(redactSecrets(text)).toBe(text)
  })

  it('is stable when run twice', () => {
    const once = redactSecrets('DB_PASSWORD=x https://u:p@h Bearer abcdefghijkl')
    expect(redactSecrets(once)).toBe(once)
  })
})

describe('requests to the model', () => {
  const settings = { provider: 'openai' as const, apiKey: 'sk-test-key-not-in-body', model: 'gpt-4o-mini', customBaseUrl: '', customModel: '' }
  const send = async (redact?: boolean) => {
    const { streamAICommand } = await import('./ai')
    const fetchMock = vi.fn(async () => new Response('data: [DONE]\n\n', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await streamAICommand(
      { ...settings, ...(redact === undefined ? {} : { redactSecrets: redact }) },
      'why does login fail with DB_PASSWORD=hunter2',
      'Authorization: Bearer abcdefghijklmnop',
      { onToken: () => {}, onDone: () => {}, onError: () => {} },
      undefined,
      [{ role: 'output', content: 'postgres://app:s3cr3t@db/app' }],
      'token: abc123',
    )
    vi.unstubAllGlobals()
    return String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body)
  }

  it('masks secrets in the prompt, terminal output, results and host facts by default', async () => {
    const body = await send()
    for (const secret of ['hunter2', 'abcdefghijklmnop', 's3cr3t', 'abc123']) expect(body).not.toContain(secret)
    expect(body).toContain('DB_PASSWORD=[redacted]')
  })

  it('sends text unchanged when masking is turned off', async () => {
    const body = await send(false)
    for (const secret of ['hunter2', 'abcdefghijklmnop', 's3cr3t', 'abc123']) expect(body).toContain(secret)
  })
})
