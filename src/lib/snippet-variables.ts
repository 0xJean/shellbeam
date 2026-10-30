// Snippet placeholders: `{{name}}` or `{{name:default}}`. Names start with a letter or `_` and may
// contain letters, digits, `_`, `-` and `.`; spaces around the name are ignored. The default is
// everything after the first `:` up to `}}` (it cannot contain `}`). Repeated names share one value.

export interface SnippetVariable {
  name: string
  defaultValue?: string
}

export type SnippetCommandPart =
  | { kind: 'text'; text: string }
  | { kind: 'variable'; text: string; name: string; defaultValue?: string }

const VARIABLE_PATTERN = /\{\{\s*([A-Za-z_][\w.-]*)\s*(?::([^}]*))?\}\}/g

export function splitSnippetCommand(command: string): SnippetCommandPart[] {
  const parts: SnippetCommandPart[] = []
  let last = 0
  for (const match of command.matchAll(VARIABLE_PATTERN)) {
    const index = match.index ?? 0
    if (index > last) parts.push({ kind: 'text', text: command.slice(last, index) })
    parts.push({ kind: 'variable', text: match[0], name: match[1], defaultValue: match[2] })
    last = index + match[0].length
  }
  if (last < command.length) parts.push({ kind: 'text', text: command.slice(last) })
  return parts
}

export function parseSnippetVariables(command: string): SnippetVariable[] {
  const byName = new Map<string, SnippetVariable>()
  for (const part of splitSnippetCommand(command)) {
    if (part.kind !== 'variable') continue
    const existing = byName.get(part.name)
    if (!existing) byName.set(part.name, part.defaultValue === undefined ? { name: part.name } : { name: part.name, defaultValue: part.defaultValue })
    else if (existing.defaultValue === undefined && part.defaultValue !== undefined) existing.defaultValue = part.defaultValue
  }
  return Array.from(byName.values())
}

export function hasSnippetVariables(command: string) {
  return parseSnippetVariables(command).length > 0
}

export function substituteSnippetVariables(command: string, values: Record<string, string>) {
  const defaults = new Map(parseSnippetVariables(command).map((variable) => [variable.name, variable.defaultValue]))
  return splitSnippetCommand(command).map((part) => {
    if (part.kind === 'text') return part.text
    const value = values[part.name]
    return value !== undefined && value !== '' ? value : defaults.get(part.name) ?? ''
  }).join('')
}
