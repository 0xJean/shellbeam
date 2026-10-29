import { describe, expect, it, vi } from 'vitest'
import { Terminal } from '@xterm/xterm'
import { createTerminalAiBridge } from './terminal-ai-bridge'

const write = (term: Terminal, data: string) => new Promise<void>((resolve) => term.write(data, resolve))

async function shell(prompt: string) {
  const term = new Terminal({ cols: 80, rows: 8, scrollback: 200 })
  await write(term, `Welcome\r\n${prompt}`)
  const sent: string[] = []
  const bridge = createTerminalAiBridge(() => term, (data) => sent.push(data), () => 'recent')
  return { term, sent, bridge }
}

describe('terminal AI bridge on a real xterm buffer', () => {
  it('reads output between the echoed command and the returned prompt', async () => {
    const { term, sent, bridge } = await shell('deploy@web:~$ ')
    const capture = bridge.run('df -h')
    expect(sent).toEqual(['df -h\r'])
    expect(capture.status!()).toBe('busy')
    await write(term, 'df -h\r\nFilesystem  Size\r\n/dev/sda1   40G\r\n')
    expect(capture.status!()).toBe('busy')
    await write(term, 'deploy@web:~$ ')
    expect(capture.status!()).toBe('prompt')
    expect(capture.read()).toBe('Filesystem  Size\n/dev/sda1   40G')
  })

  it('treats a prompt with a new directory as finished, and spots questions', async () => {
    const { term, bridge } = await shell('root@web:~# ')
    const cd = bridge.run('cd /var/log')
    await write(term, 'cd /var/log\r\nroot@web:/var/log# ')
    expect(cd.status!()).toBe('prompt')
    expect(cd.read()).toBe('')
    const apt = bridge.run('apt upgrade')
    await write(term, 'apt upgrade\r\nAfter this operation, 2 MB will be used.\r\nDo you want to continue? [Y/n] ')
    expect(apt.status!()).toBe('input')
  })

  it('keeps working once output scrolls past the screen', async () => {
    const { term, bridge } = await shell('$ ')
    const capture = bridge.run('seq 50')
    await write(term, 'seq 50\r\n' + Array.from({ length: 50 }, (_, i) => `${i + 1}`).join('\r\n') + '\r\n$ ')
    expect(capture.status!()).toBe('prompt')
    expect(capture.read().split('\n')).toHaveLength(50)
  })

  it('leaves the header lines of a multi-line prompt out of the output', async () => {
    const header = '~/app via nodejs v22.22.1 on gcp user@example.com'
    const { term, bridge } = await shell(`\r\n${header}\r\n> `)
    const capture = bridge.run('df -h /')
    await write(term, `df -h /\r\nFilesystem  Size\r\n/dev/sda1   40G\r\n\r\n${header}\r\n> `)
    expect(capture.status!()).toBe('prompt')
    expect(capture.read()).toBe('Filesystem  Size\n/dev/sda1   40G')
    const cd = bridge.run('cd /tmp')
    await write(term, 'cd /tmp\r\n\r\n/tmp via nodejs v22.22.1 on gcp user@example.com\r\n> ')
    expect(cd.read()).toBe('')
  })

  it('handles a prompt line that wraps or gains a duration after a slow command', async () => {
    const header = 'app on git main [!?] via nodejs v22.22.1 on gcp user@example.com'
    const { term, bridge } = await shell(`\r\n${header}\r\n> `)
    const slow = bridge.run('sleep 2; echo slept')
    const long = `${header} took 2s`.padEnd(81, ' ')
    await write(term, `sleep 2; echo slept\r\nslept\r\n\r\n${long}\r\n> `)
    expect(slow.status!()).toBe('prompt')
    expect(slow.read()).toBe('slept')
    const cd = bridge.run('cd /tmp')
    await write(term, 'cd /tmp\r\n\r\n/tmp via nodejs v22.22.1 on gcp user@example.com\r\n> ')
    expect(cd.read()).toBe('')
  })

  it('sends Ctrl+C and clears', async () => {
    const { term, sent, bridge } = await shell('$ ')
    const clear = vi.spyOn(term, 'clear')
    bridge.interrupt!(); bridge.clear!()
    expect(sent).toEqual(['\x03'])
    expect(clear).toHaveBeenCalled()
  })
})
