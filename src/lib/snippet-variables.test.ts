import { describe, expect, it } from 'vitest'

import { hasSnippetVariables, parseSnippetVariables, splitSnippetCommand, substituteSnippetVariables } from './snippet-variables'

describe('snippet variables', () => {
  it('parses unique names with optional defaults', () => {
    expect(parseSnippetVariables('pg_dump {{db}} > /backup/{{ db }}-{{stamp:latest}}.sql && ss | grep :{{port:8080}}')).toEqual([
      { name: 'db' },
      { name: 'stamp', defaultValue: 'latest' },
      { name: 'port', defaultValue: '8080' },
    ])
  })

  it('takes the first default declared for a repeated name', () => {
    expect(parseSnippetVariables('{{host}} {{host:a}} {{host:b}}')).toEqual([{ name: 'host', defaultValue: 'a' }])
  })

  it('ignores text that is not a placeholder', () => {
    expect(hasSnippetVariables('echo ${HOME} {{}} {{1abc}} { {x} }')).toBe(false)
    expect(hasSnippetVariables('echo {{x}}')).toBe(true)
  })

  it('splits a command into text and variable parts', () => {
    expect(splitSnippetCommand('du -ah {{path}} | head')).toEqual([
      { kind: 'text', text: 'du -ah ' },
      { kind: 'variable', text: '{{path}}', name: 'path', defaultValue: undefined },
      { kind: 'text', text: ' | head' },
    ])
    expect(splitSnippetCommand('')).toEqual([])
  })

  it('substitutes values and falls back to defaults', () => {
    const command = 'pg_dump {{db}} | gzip > /backup/{{db}}-{{suffix:full}}.gz :{{port:5432}}'
    expect(substituteSnippetVariables(command, { db: 'app', port: '' })).toBe('pg_dump app | gzip > /backup/app-full.gz :5432')
    expect(substituteSnippetVariables(command, { db: 'app', suffix: 'x', port: '6543' })).toBe('pg_dump app | gzip > /backup/app-x.gz :6543')
  })

  it('replaces a missing value without a default with an empty string', () => {
    expect(substituteSnippetVariables('echo [{{name}}]', {})).toBe('echo []')
  })

  it('leaves commands without variables unchanged', () => {
    expect(substituteSnippetVariables('sudo nginx -t && echo "{ok}"', {})).toBe('sudo nginx -t && echo "{ok}"')
  })
})
