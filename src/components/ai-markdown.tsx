import { useState, type ReactNode } from 'react'
import { Check, Copy } from 'lucide-react'
import { cn } from '@/lib/utils'

interface Block {
  type: 'heading' | 'paragraph' | 'ul' | 'ol' | 'code' | 'table'
  level?: number
  lang?: string
  lines?: string[]
  headers?: string[]
  rows?: string[][]
}

function isTableSeparator(line: string): boolean {
  const trimmed = line.trim()
  if (!trimmed.includes('|')) return false
  const cells = trimmed.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim())
  return cells.length >= 2 && cells.every((cell) => /^:?-{3,}:?$/.test(cell))
}

function splitTableRow(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim())
}

function parseBlocks(markdown: string): Block[] {
  const rawLines = markdown.replace(/\r/g, '').split('\n')
  const blocks: Block[] = []
  let i = 0

  while (i < rawLines.length) {
    const line = rawLines[i]
    const trimmed = line.trim()

    if (!trimmed) {
      i += 1
      continue
    }

    // Fenced code block
    if (trimmed.startsWith('```')) {
      const lang = trimmed.slice(3).trim()
      const codeLines: string[] = []
      i += 1
      while (i < rawLines.length && !rawLines[i].trim().startsWith('```')) {
        codeLines.push(rawLines[i])
        i += 1
      }
      if (i < rawLines.length) i += 1
      blocks.push({ type: 'code', lang, lines: codeLines })
      continue
    }

    // Heading (#, ##, ###)
    const heading = trimmed.match(/^(#{1,3})\s+(.+)$/)
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length, lines: [heading[2]] })
      i += 1
      continue
    }

    // Markdown table
    if (trimmed.includes('|') && i + 1 < rawLines.length && isTableSeparator(rawLines[i + 1])) {
      const headers = splitTableRow(trimmed)
      i += 2
      const rows: string[][] = []
      while (i < rawLines.length && rawLines[i].trim().includes('|')) {
        rows.push(splitTableRow(rawLines[i]))
        i += 1
      }
      blocks.push({ type: 'table', headers, rows })
      continue
    }

    // Unordered list
    if (/^[-*+]\s+/.test(trimmed)) {
      const items: string[] = []
      while (i < rawLines.length && /^[-*+]\s+/.test(rawLines[i].trim())) {
        items.push(rawLines[i].trim().replace(/^[-*+]\s+/, ''))
        i += 1
      }
      blocks.push({ type: 'ul', lines: items })
      continue
    }

    // Ordered list
    if (/^\d+\.\s+/.test(trimmed)) {
      const items: string[] = []
      while (i < rawLines.length && /^\d+\.\s+/.test(rawLines[i].trim())) {
        items.push(rawLines[i].trim().replace(/^\d+\.\s+/, ''))
        i += 1
      }
      blocks.push({ type: 'ol', lines: items })
      continue
    }

    // Paragraph (collect consecutive plain lines)
    const para: string[] = []
    while (
      i < rawLines.length
      && rawLines[i].trim()
      && !rawLines[i].trim().startsWith('```')
      && !/^#{1,3}\s+/.test(rawLines[i].trim())
      && !/^[-*+]\s+/.test(rawLines[i].trim())
      && !/^\d+\.\s+/.test(rawLines[i].trim())
      && !(rawLines[i].trim().includes('|') && i + 1 < rawLines.length && isTableSeparator(rawLines[i + 1]))
    ) {
      para.push(rawLines[i].trim())
      i += 1
    }
    blocks.push({ type: 'paragraph', lines: para })
  }

  return blocks
}

function renderInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = []
  const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*)/g
  let lastIndex = 0
  let key = 0
  for (const match of text.matchAll(pattern)) {
    const idx = match.index ?? 0
    if (idx > lastIndex) nodes.push(text.slice(lastIndex, idx))
    const token = match[0]
    if (token.startsWith('`')) {
      nodes.push(
        <code key={key++} className="rounded bg-[var(--workspace-surface-800)] px-1 py-0.5 font-mono text-[11.5px] text-[var(--workspace-text-strong)]">
          {token.slice(1, -1)}
        </code>,
      )
    } else if (token.startsWith('**')) {
      nodes.push(<strong key={key++} className="font-semibold text-[var(--workspace-text-strong)]">{token.slice(2, -2)}</strong>)
    } else {
      nodes.push(<em key={key++} className="italic">{token.slice(1, -1)}</em>)
    }
    lastIndex = idx + token.length
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex))
  return nodes
}

function CodeBlock({ lang, code }: { lang?: string; code: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* ignore */ }
  }
  return (
    <div className="overflow-hidden rounded-md border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-950)]">
      <div className="flex items-center justify-between border-b border-[color:var(--workspace-border-soft)] px-2.5 py-1 text-[10.5px] text-[var(--workspace-text-subtle)]">
        <span className="font-mono">{lang || 'text'}</span>
        <button type="button" onClick={() => void copy()} className="inline-flex items-center gap-1 hover:text-[var(--workspace-text-strong)]">
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
        </button>
      </div>
      <pre className="max-h-56 overflow-auto px-2.5 py-2 font-mono text-[11.5px] leading-relaxed text-[var(--workspace-text-strong)]">{code}</pre>
    </div>
  )
}

/** Lightweight, XSS-safe Markdown renderer for AI diagnostic answers (tables, lists, headings, code). */
export function AIMarkdown({ content, className }: { content: string; className?: string }) {
  const blocks = parseBlocks(content)
  return (
    <div className={cn('space-y-2 text-[13px] leading-relaxed text-[var(--workspace-text-strong)]', className)}>
      {blocks.map((block, index) => {
        if (block.type === 'heading') {
          const text = block.lines?.[0] ?? ''
          return (
            <p key={index} className={cn('font-semibold text-[var(--workspace-text-strong)]', block.level === 1 ? 'text-[14px]' : 'text-[13px]')}>
              {renderInline(text)}
            </p>
          )
        }
        if (block.type === 'code') {
          return <CodeBlock key={index} lang={block.lang} code={(block.lines ?? []).join('\n')} />
        }
        if (block.type === 'table') {
          const headers = block.headers ?? []
          const rows = block.rows ?? []
          return (
            <div key={index} className="overflow-x-auto rounded-md border border-[color:var(--workspace-border-soft)]">
              <table className="w-full border-collapse text-left text-[11.5px]">
                <thead className="bg-[var(--workspace-surface-800)] text-[var(--workspace-text-muted)]">
                  <tr>
                    {headers.map((cell, ci) => (
                      <th key={ci} className="border-b border-[color:var(--workspace-border-soft)] px-2 py-1 font-medium">{renderInline(cell)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, ri) => (
                    <tr key={ri} className="border-b border-[color:var(--workspace-border-soft)] last:border-b-0">
                      {headers.map((_, ci) => (
                        <td key={ci} className="px-2 py-1 font-mono text-[11px] text-[var(--workspace-text)]">{renderInline(row[ci] ?? '')}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
        if (block.type === 'ul') {
          return (
            <ul key={index} className="list-disc space-y-1 pl-4 text-[12.5px]">
              {(block.lines ?? []).map((item, ii) => <li key={ii} className="break-words">{renderInline(item)}</li>)}
            </ul>
          )
        }
        if (block.type === 'ol') {
          return (
            <ol key={index} className="list-decimal space-y-1 pl-4 text-[12.5px]">
              {(block.lines ?? []).map((item, ii) => <li key={ii} className="break-words">{renderInline(item)}</li>)}
            </ol>
          )
        }
        return (
          <p key={index} className="whitespace-pre-wrap break-words">
            {(block.lines ?? []).map((line, li) => (
              <span key={li}>
                {li > 0 && <br />}
                {renderInline(line)}
              </span>
            ))}
          </p>
        )
      })}
    </div>
  )
}
