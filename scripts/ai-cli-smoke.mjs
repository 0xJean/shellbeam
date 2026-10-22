// Opt-in real-CLI/production-adapter smoke with isolated homes and fake loopback models.
// Usage: node scripts/ai-cli-smoke.mjs codex-cli /absolute/path/to/codex
//        node scripts/ai-cli-smoke.mjs claude-code /absolute/path/to/claude
import http from 'node:http'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { gunzipSync, brotliDecompressSync, zstdDecompressSync } from 'node:zlib'
import assert from 'node:assert/strict'
const [backend, executable] = process.argv.slice(2)
assert(['claude-code', 'codex-cli'].includes(backend) && path.isAbsolute(executable))
assert(process.platform !== 'win32', 'This isolated shell fixture runs on macOS/Linux; production Windows uses native .exe')
const dir = await mkdtemp(path.join(os.tmpdir(), 'shellbeam-ai-cli-smoke-'))
const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`
let requestCount = 0
let tools = []
let fixtureError = null
const server = http.createServer(async (req, res) => {
  try {
    const parts = []; for await (const chunk of req) parts.push(chunk)
    let bytes = Buffer.concat(parts)
    if (req.headers['content-encoding'] === 'gzip') bytes = gunzipSync(bytes)
    if (req.headers['content-encoding'] === 'br') bytes = brotliDecompressSync(bytes)
    if (req.headers['content-encoding'] === 'zstd') bytes = zstdDecompressSync(bytes)
    if (!req.url.includes('responses') && !req.url.includes('messages')) { res.writeHead(404); res.end('{}'); return }
    const body = JSON.parse(bytes.toString())
    tools = (body.tools ?? []).map((t) => t.name ?? t.type)
    requestCount++
    if (backend === 'claude-code') assert.deepEqual(tools, [])
    else assert(tools.every((t) => ['apply_patch', 'current_time', 'clock__curr_time'].includes(t)), `Unexpected tools: ${tools.join(',')}`)
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    const event = (name, data) => res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
    if (backend === 'claude-code') {
      event('message_start', { type: 'message_start', message: { id: 'msg_fixture', type: 'message', role: 'assistant', content: [], model: body.model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } })
      event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
      event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'pwd' } })
      event('content_block_stop', { type: 'content_block_stop', index: 0 })
      event('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } })
      event('message_stop', { type: 'message_stop' })
    } else {
      const item = { id: 'msg_fixture', type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'pwd', annotations: [] }] }
      event('response.created', { type: 'response.created', response: { id: 'resp_fixture', status: 'in_progress', output: [] } })
      event('response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } })
      event('response.output_text.delta', { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: 'pwd' })
      event('response.output_item.done', { type: 'response.output_item.done', output_index: 0, item })
      event('response.completed', { type: 'response.completed', response: { id: 'resp_fixture', status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 } } })
    }
    res.end()
  } catch (error) { fixtureError = error; res.writeHead(500); res.end('{}') }
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
try {
  for (const name of ['home', 'codex', 'claude', 'config', 'data', 'cache']) await mkdir(path.join(dir, name))
  const endpoint = `http://127.0.0.1:${server.address().port}`
  const env = { HOME: path.join(dir, 'home'), USERPROFILE: path.join(dir, 'home'), CODEX_HOME: path.join(dir, 'codex'), CLAUDE_CONFIG_DIR: path.join(dir, 'claude'), XDG_CONFIG_HOME: path.join(dir, 'config'), XDG_DATA_HOME: path.join(dir, 'data'), XDG_CACHE_HOME: path.join(dir, 'cache'), ANTHROPIC_API_KEY: 'fixture-not-a-real-key', ANTHROPIC_BASE_URL: endpoint, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' }
  const fixed = Object.entries(env).map(([k, v]) => `${k}=${quote(v)}`).join(' ')
  const codexConfig = ['-c', 'model_provider="fixture"', '-c', `model_providers.fixture={name="Loopback fixture",base_url="${endpoint}/v1",wire_api="responses",requires_openai_auth=false}`].map(quote).join(' ')
  const wrapper = path.join(dir, 'isolated-cli')
  // env -i prevents the real user's API/OAuth tokens or endpoint overrides entering the child.
  await writeFile(wrapper, `#!/bin/bash\nset -o pipefail\n/usr/bin/env -i PATH=${quote(process.env.PATH)} ${fixed} ${quote(executable)} "$@" ${backend === 'codex-cli' ? codexConfig : ''} 2>${quote(path.join(dir, 'isolated-stderr'))} | /usr/bin/tee ${quote(path.join(dir, 'isolated-stdout'))}\n`, { mode: 0o700 })
  const code = await new Promise((resolve) => {
    const child = spawn('cargo', ['test', '--manifest-path', 'src-tauri/Cargo.toml', '--locked', '--lib', 'installed_cli_loopback_generation', '--', '--ignored', '--nocapture'], { stdio: 'inherit', env: { ...process.env, SHELLBEAM_AI_CLI_SMOKE_BACKEND: backend, SHELLBEAM_AI_CLI_SMOKE_EXECUTABLE: wrapper } })
    child.on('exit', resolve)
  })
  if (code !== 0) { console.error((await readFile(path.join(dir, 'isolated-stderr'), 'utf8')).slice(0, 6000)); console.error((await readFile(path.join(dir, 'isolated-stdout'), 'utf8')).slice(0, 6000)); console.error({ requestCount, tools }) }
  if (fixtureError) throw fixtureError
  assert.equal(code, 0)
  assert.equal(requestCount, 1)
  console.log(JSON.stringify({ backend, result: 'passed', requests: requestCount, advertisedTools: tools, realModelRequest: false, realCredentials: false, generatedCommandExecuted: false }))
} finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); await rm(dir, { recursive: true, force: true }) }
