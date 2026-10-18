import { describe, expect, it } from 'vitest'
import { komariConsoleUrl } from './komari-console'

describe('Komari console URL', () => {
  it.each([
    ['https://komari.example', 'https://komari.example/'],
    ['https://komari.example/reverse/proxy', 'https://komari.example/reverse/proxy/'],
    ['https://komari.example/reverse/proxy/', 'https://komari.example/reverse/proxy/'],
    ['https://komari.example/team%20ops?token=never-pass#api-key', 'https://komari.example/team%20ops/'],
    ['http://192.168.1.20:25774/monitoring', 'http://192.168.1.20:25774/monitoring/'],
    ['http://[::1]:25774', 'http://[::1]:25774/'],
  ])('keeps the HTTP(S) base path without credentials or URL state: %s', (endpoint, expected) => {
    expect(komariConsoleUrl(endpoint)).toBe(expected)
    expect(new URL('assets/app.js', komariConsoleUrl(endpoint)).pathname).toBe(`${new URL(expected).pathname}assets/app.js`)
  })

  it.each(['', 'komari.example', 'javascript:alert(1)', 'data:text/html,hello', 'file:///tmp/console', 'ftp://komari.example', 'https://user:password@komari.example', 'https://token@komari.example', 'https://user%40name:secret@komari.example'])('rejects unsafe or malformed console addresses: %s', (endpoint) => {
    expect(() => komariConsoleUrl(endpoint)).toThrow()
  })
})
