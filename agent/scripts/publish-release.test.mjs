import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, verify } from 'node:crypto'
import { signedRelease, artifactPayload, releasePayload } from './publish-release.mjs'
test('publisher binds exact bytes/platform/channel/rollout to distinct Ed25519 signatures',()=>{
  const artifact=generateKeyPairSync('ed25519');const release=generateKeyPairSync('ed25519')
  const input={bytes:Buffer.from('actual executable bytes'),version:'0.1.0',platform:'linux',architecture:'x86_64',url:'https://example.com/agent',artifactKey:artifact.privateKey.export({type:'pkcs8',format:'pem'}),releaseKey:release.privateKey.export({type:'pkcs8',format:'pem'}),now:1234567890000}
  const manifest=signedRelease(input)
  assert(verify(null,Buffer.from(artifactPayload(manifest.artifact)),artifact.publicKey,Buffer.from(manifest.artifact.signature,'base64')))
  assert(verify(null,Buffer.from(releasePayload(manifest)),release.publicKey,Buffer.from(manifest.releaseSignature,'base64')))
  assert(!verify(null,Buffer.from(releasePayload({...manifest,channel:'canary'})),release.publicKey,Buffer.from(manifest.releaseSignature,'base64')))
  assert.throws(()=>signedRelease({...input,url:'http://example.com/agent'}))
  assert.throws(()=>signedRelease({...input,version:'bad; shell'}))
})
