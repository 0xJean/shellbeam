#!/usr/bin/env node
/**
 * App Store Connect TestFlight post-upload automation for ShellBeam.
 *
 * Waits for the uploaded build to finish processing, sets export compliance
 * (usesNonExemptEncryption = false) if still unset, writes "What to Test" notes,
 * attaches the build to the public-link External Testing group, and submits it
 * for Beta App Review.
 *
 * Required environment variables (loaded from .env if present):
 *   ASC_ISSUER_ID           App Store Connect API Issuer ID (UUID)
 *   ASC_KEY_ID              App Store Connect API Key ID (10 chars)
 *   ASC_PRIVATE_KEY_PATH    Path to AuthKey_<KEY_ID>.p8 (or ASC_PRIVATE_KEY_BASE64)
 *
 * Optional:
 *   ASC_BUNDLE_ID           Default: app.shellbeam
 *   ASC_EXTERNAL_GROUP_NAME Match a specific external group name; otherwise auto-picks
 *                           the external group with publicLinkEnabled = true
 *   ASC_WAIT_TIMEOUT_SECS   Default: 1500 (25 min)
 *
 * Usage:
 *   node scripts/ios-tf-distribute.mjs [--version 0.1.20] [--build 20261127.1924]
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT_DIR = path.resolve(__dirname, '..')

function loadDotEnv() {
  const envPath = path.join(ROOT_DIR, '.env')
  if (!fs.existsSync(envPath)) return
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/)
  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    let val = line.slice(eq + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    if (!process.env[key]) process.env[key] = val
  }
}

function parseArgs(argv) {
  const out = { version: '', build: '' }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--version' && argv[i + 1]) out.version = argv[++i]
    else if (argv[i] === '--build' && argv[i + 1]) out.build = argv[++i]
  }
  if (!out.version) {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'))
    out.version = pkg.version
  }
  return out
}

function base64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
}

function makeAscJwt({ issuerId, keyId, privateKeyPem }) {
  const now = Math.floor(Date.now() / 1000)
  const header = base64url(JSON.stringify({ alg: 'ES256', kid: keyId, typ: 'JWT' }))
  const payload = base64url(JSON.stringify({
    iss: issuerId,
    iat: now,
    exp: now + 15 * 60,
    aud: 'appstoreconnect-v1',
  }))
  const signingInput = `${header}.${payload}`
  const sig = crypto.sign('sha256', Buffer.from(signingInput), {
    key: privateKeyPem,
    dsaEncoding: 'ieee-p1363',
  })
  return `${signingInput}.${base64url(sig)}`
}

function readPrivateKey() {
  if (process.env.ASC_PRIVATE_KEY_BASE64) {
    return Buffer.from(process.env.ASC_PRIVATE_KEY_BASE64, 'base64').toString('utf8')
  }
  const keyPath = process.env.ASC_PRIVATE_KEY_PATH
  if (!keyPath) return ''
  const resolved = keyPath.startsWith('~/')
    ? path.join(process.env.HOME || '', keyPath.slice(2))
    : path.resolve(ROOT_DIR, keyPath)
  return fs.readFileSync(resolved, 'utf8')
}

async function ascRequest(creds, method, apiPath, body) {
  const url = apiPath.startsWith('https://')
    ? apiPath
    : `https://api.appstoreconnect.apple.com${apiPath}`
  let lastErr
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const token = makeAscJwt(creds)
      const res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      const text = await res.text()
      let json = null
      try {
        json = text ? JSON.parse(text) : null
      } catch {
        json = { raw: text }
      }
      return { ok: res.ok, status: res.status, json }
    } catch (err) {
      lastErr = err
      if (attempt < 3) await sleep(2000 * attempt)
    }
  }
  throw lastErr
}

function loadReleaseHighlights(version) {
  const releaseDoc = path.join(ROOT_DIR, 'docs', 'releases', `v${version}.md`)
  if (!fs.existsSync(releaseDoc)) {
    return {
      'zh-Hans': `ShellBeam v${version} 测试版本更新。`,
      'en-US': `ShellBeam v${version} TestFlight update.`,
    }
  }
  const md = fs.readFileSync(releaseDoc, 'utf8')
  const [zhPart, enPart] = md.split(/^##\s+English\s*$/m)
  const clean = (s) => s
    .replace(/^#.*$/gm, '')
    .replace(/[*`]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 3800)
  return {
    'zh-Hans': clean(zhPart || '') || `ShellBeam v${version} 测试版本更新。`,
    'en-US': clean(enPart || '') || `ShellBeam v${version} TestFlight update.`,
  }
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function main() {
  loadDotEnv()
  const { version, build } = parseArgs(process.argv.slice(2))
  const issuerId = process.env.ASC_ISSUER_ID || ''
  const keyId = process.env.ASC_KEY_ID || ''
  const privateKeyPem = readPrivateKey()
  const bundleId = process.env.ASC_BUNDLE_ID || 'app.shellbeam'
  const externalGroupName = process.env.ASC_EXTERNAL_GROUP_NAME || ''
  const timeoutSecs = Number(process.env.ASC_WAIT_TIMEOUT_SECS || 1500)

  if (!issuerId || !keyId || !privateKeyPem) {
    console.error('❌ Missing App Store Connect API credentials in .env:')
    console.error('   Required: ASC_ISSUER_ID, ASC_KEY_ID, ASC_PRIVATE_KEY_PATH (or ASC_PRIVATE_KEY_BASE64)')
    console.error('   See docs/release-process.md §4.3 for one-time setup instructions.')
    process.exit(1)
  }

  const creds = { issuerId, keyId, privateKeyPem }

  // 1. Resolve App ID
  const appRes = await ascRequest(creds, 'GET', `/v1/apps?filter[bundleId]=${encodeURIComponent(bundleId)}`)
  if (!appRes.ok || !appRes.json?.data?.length) {
    console.error('❌ Failed to locate app in App Store Connect:', appRes.status, JSON.stringify(appRes.json))
    process.exit(1)
  }
  const appId = appRes.json.data[0].id
  console.log(`📱 App Store Connect App: ${bundleId} (${appId})`)

  // 2. Poll until the target build is VALID
  const deadline = Date.now() + timeoutSecs * 1000
  let targetBuild = null
  const buildFilter = build ? `&filter[version]=${encodeURIComponent(build)}` : ''
  const query = `/v1/builds?filter[app]=${appId}&filter[preReleaseVersion.version]=${encodeURIComponent(version)}${buildFilter}&sort=-uploadedDate&limit=5`

  console.log(`⏳ Waiting for build v${version}${build ? ` (${build})` : ''} to finish processing...`)
  while (Date.now() < deadline) {
    const res = await ascRequest(creds, 'GET', query)
    if (!res.ok) {
      console.error('❌ Failed to query builds:', res.status, JSON.stringify(res.json))
      process.exit(1)
    }
    const candidate = res.json?.data?.[0]
    if (candidate) {
      const state = candidate.attributes?.processingState
      const ver = candidate.attributes?.version
      if (state === 'VALID') {
        targetBuild = candidate
        console.log(`✅ Build ${version} (${ver}) is VALID (${candidate.id})`)
        break
      }
      if (state === 'FAILED' || state === 'INVALID') {
        console.error(`❌ Build ${version} (${ver}) ended in state ${state}`)
        process.exit(1)
      }
      console.log(`   Build ${version} (${ver}) state: ${state} — checking again in 20s...`)
    } else {
      console.log('   Build not yet visible on App Store Connect — checking again in 20s...')
    }
    await sleep(20_000)
  }

  if (!targetBuild) {
    console.error(`❌ Timed out after ${timeoutSecs}s waiting for build v${version} to become VALID.`)
    process.exit(1)
  }

  // 3. Clear export compliance if missing
  if (targetBuild.attributes?.usesNonExemptEncryption === null || targetBuild.attributes?.usesNonExemptEncryption === undefined) {
    console.log('🔐 Setting export compliance (usesNonExemptEncryption = false)...')
    const patchRes = await ascRequest(creds, 'PATCH', `/v1/builds/${targetBuild.id}`, {
      data: {
        type: 'builds',
        id: targetBuild.id,
        attributes: { usesNonExemptEncryption: false },
      },
    })
    if (!patchRes.ok) {
      console.error('❌ Failed to update export compliance:', patchRes.status, JSON.stringify(patchRes.json))
      process.exit(1)
    }
    console.log('✅ Export compliance marked exempt.')
  } else {
    console.log(`✅ Export compliance already set (usesNonExemptEncryption = ${targetBuild.attributes.usesNonExemptEncryption}).`)
  }

  // 4. Upsert "What to Test" beta build localizations
  const notesByLocale = loadReleaseHighlights(version)
  const existingLocsRes = await ascRequest(creds, 'GET', `/v1/builds/${targetBuild.id}/betaBuildLocalizations`)
  const existingLocs = existingLocsRes.ok ? (existingLocsRes.json?.data || []) : []
  for (const [loc, whatsNew] of Object.entries(notesByLocale)) {
    const found = existingLocs.find((item) => item.attributes?.locale === loc)
    if (found) {
      await ascRequest(creds, 'PATCH', `/v1/betaBuildLocalizations/${found.id}`, {
        data: { type: 'betaBuildLocalizations', id: found.id, attributes: { whatsNew } },
      })
    } else {
      await ascRequest(creds, 'POST', '/v1/betaBuildLocalizations', {
        data: {
          type: 'betaBuildLocalizations',
          attributes: { locale: loc, whatsNew },
          relationships: { build: { data: { type: 'builds', id: targetBuild.id } } },
        },
      })
    }
  }
  console.log('✅ Updated TestFlight "What to Test" notes (zh-Hans & en-US).')

  // 5. Find public External Testing group & attach build
  const groupsRes = await ascRequest(creds, 'GET', `/v1/apps/${appId}/betaGroups?limit=50`)
  if (!groupsRes.ok) {
    console.error('❌ Failed to list beta groups:', groupsRes.status, JSON.stringify(groupsRes.json))
    process.exit(1)
  }
  const externalGroups = (groupsRes.json?.data || []).filter((g) => !g.attributes?.isInternalGroup)
  const targetGroup = externalGroupName
    ? externalGroups.find((g) => g.attributes?.name === externalGroupName)
    : externalGroups.find((g) => g.attributes?.publicLinkEnabled) || externalGroups[0]

  if (!targetGroup) {
    console.error('❌ No external TestFlight beta group found. Create one in App Store Connect first.')
    process.exit(1)
  }

  console.log(`🔗 Attaching build to external group "${targetGroup.attributes?.name}" (${targetGroup.attributes?.publicLink || targetGroup.id})...`)
  const attachRes = await ascRequest(creds, 'POST', `/v1/betaGroups/${targetGroup.id}/relationships/builds`, {
    data: [{ type: 'builds', id: targetBuild.id }],
  })
  if (!attachRes.ok) {
    console.error('❌ Failed to attach build to external group:', attachRes.status, JSON.stringify(attachRes.json))
    process.exit(1)
  }
  console.log('✅ Build attached to public external TestFlight group.')

  // 6. Check current review state & submit for Beta App Review if needed
  const detailRes = await ascRequest(
    creds,
    'GET',
    `/v1/builds/${targetBuild.id}?include=betaAppReviewSubmission,buildBetaDetail`,
  )
  const included = detailRes.ok ? (detailRes.json?.included || []) : []
  const existingSub = included.find((i) => i.type === 'betaAppReviewSubmissions')
  const betaDetail = included.find((i) => i.type === 'buildBetaDetails')
  const reviewState = existingSub?.attributes?.betaReviewState
  const externalState = betaDetail?.attributes?.externalBuildState

  if (
    reviewState === 'WAITING_FOR_REVIEW' ||
    reviewState === 'IN_REVIEW' ||
    reviewState === 'APPROVED' ||
    externalState === 'WAITING_FOR_BETA_REVIEW' ||
    externalState === 'IN_BETA_TESTING'
  ) {
    console.log(`✅ Beta App Review already active (review: ${reviewState || 'N/A'}, external: ${externalState || 'N/A'}).`)
    return
  }

  console.log('📝 Submitting build for Beta App Review...')
  const submitRes = await ascRequest(creds, 'POST', '/v1/betaAppReviewSubmissions', {
    data: {
      type: 'betaAppReviewSubmissions',
      relationships: { build: { data: { type: 'builds', id: targetBuild.id } } },
    },
  })
  if (submitRes.ok) {
    console.log(`✅ Submitted for Beta App Review (state: ${submitRes.json?.data?.attributes?.betaReviewState || 'WAITING_FOR_REVIEW'})`)
  } else if (submitRes.status === 409) {
    console.log('ℹ️ Build is already submitted or approved for Beta App Review.')
  } else {
    console.error('❌ Beta App Review submission failed:', submitRes.status, JSON.stringify(submitRes.json))
    process.exit(1)
  }
}

main().catch((err) => {
  console.error('❌ Unexpected error:', err)
  process.exit(1)
})
