import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const TARGETS = [['linux', 'x86_64'], ['linux', 'aarch64'], ['macos', 'x86_64'], ['macos', 'aarch64']]
const ARTIFACT_IDS = new Set(TARGETS.map(([platform, architecture]) => `shellbeam-agent-${platform}-${architecture}`))
const SHA256 = /^[a-f0-9]{64}$/i

export const artifactPayload = (manifest) => JSON.stringify({artifactId:manifest.artifactId,version:manifest.version,platform:manifest.platform,architecture:manifest.architecture,url:manifest.url,sha256:manifest.sha256.toLowerCase(),sizeBytes:manifest.sizeBytes??null})
export const releasePayload = (manifest) => JSON.stringify({releaseId:manifest.releaseId,channel:manifest.channel,publishedAt:manifest.publishedAt,expiresAt:manifest.expiresAt??null,minAgentVersion:manifest.minAgentVersion??null,maxAgentVersion:manifest.maxAgentVersion??null,rollout:manifest.rollout??{percentage:100,salt:'default'},previousSha256:manifest.previousSha256??null,rollbackOf:manifest.rollbackOf??null,artifactId:manifest.artifact.artifactId,artifactVersion:manifest.artifact.version,artifactSha256:manifest.artifact.sha256.toLowerCase()})
export function signedRelease({bytes,version,platform,architecture,url,channel='stable',artifactKey,releaseKey,now=Date.now(),rolloutPercentage=100,previousSha256}) {
  if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version)||!['linux','macos'].includes(platform)||!['x86_64','aarch64'].includes(architecture)||!['stable','preview','canary'].includes(channel)) throw new Error('release_arguments_invalid')
  const parsed=new URL(url);if(parsed.protocol!=='https:'||parsed.username||parsed.password||parsed.hash)throw new Error('release_url_invalid')
  if(bytes.length===0||bytes.length>32*1024*1024)throw new Error('artifact_size_invalid')
  if(!Number.isInteger(rolloutPercentage)||rolloutPercentage<0||rolloutPercentage>100)throw new Error('release_rollout_invalid')
  if(previousSha256!==undefined&&(typeof previousSha256!=='string'||!SHA256.test(previousSha256)))throw new Error('previous_hash_invalid')
  const artifactSigningKey=createPrivateKey(artifactKey);const releaseSigningKey=createPrivateKey(releaseKey)
  if(artifactSigningKey.asymmetricKeyType!=='ed25519'||releaseSigningKey.asymmetricKeyType!=='ed25519')throw new Error('ed25519_keys_required')
  if(createPublicKey(artifactSigningKey).export({type:'spki',format:'der'}).equals(createPublicKey(releaseSigningKey).export({type:'spki',format:'der'})))throw new Error('independent_signing_keys_required')
  const artifact={artifactId:`shellbeam-agent-${platform}-${architecture}`,version,platform,architecture,url:parsed.toString(),sha256:createHash('sha256').update(bytes).digest('hex'),sizeBytes:bytes.length,signatureAlgorithm:'ed25519'}
  artifact.signature=sign(null,Buffer.from(artifactPayload(artifact)),artifactSigningKey).toString('base64')
  const release={releaseId:`agent-${version}-${platform}-${architecture}`,channel,publishedAt:now,expiresAt:now+90*24*60*60*1000,rollout:{percentage:rolloutPercentage,salt:`agent-${version}`},...(previousSha256?{previousSha256:previousSha256.toLowerCase()}:{}),artifact,releaseSignatureAlgorithm:'ed25519'}
  release.releaseSignature=sign(null,Buffer.from(releasePayload(release)),releaseSigningKey).toString('base64')
  return release
}
/** A previous executable hash belongs to one platform/architecture, never all four. */
export function parsePublisherOptions(args) {
  const allowed = new Set(['--input-dir', '--output', '--version', '--base-url', '--channel', '--rollout-percentage', '--previous-hashes'])
  const options = new Map()
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]
    const value = args[index + 1]
    if (!allowed.has(name) || options.has(name) || typeof value !== 'string' || !value.trim() || value.startsWith('--')) throw new Error('release_arguments_invalid')
    options.set(name, value)
  }
  for (const name of ['--input-dir', '--output', '--version', '--base-url']) if (!options.has(name)) throw new Error(`${name}_required`)
  const rolloutText = options.get('--rollout-percentage') ?? '100'
  if (!/^\d{1,3}$/.test(rolloutText) || Number(rolloutText) > 100) throw new Error('release_rollout_invalid')
  let hashes
  try { hashes = JSON.parse(options.get('--previous-hashes') ?? '{}') } catch { throw new Error('previous_hashes_invalid') }
  if (!hashes || typeof hashes !== 'object' || Array.isArray(hashes)) throw new Error('previous_hashes_invalid')
  for (const [artifactId, hash] of Object.entries(hashes)) {
    if (!ARTIFACT_IDS.has(artifactId) || typeof hash !== 'string' || !SHA256.test(hash)) throw new Error('previous_hashes_invalid')
  }
  return {
    input: resolve(options.get('--input-dir')),
    output: resolve(options.get('--output')),
    version: options.get('--version'),
    base: options.get('--base-url').replace(/\/$/, ''),
    channel: options.get('--channel') ?? 'stable',
    rolloutPercentage: Number(rolloutText),
    previousHashes: hashes,
  }
}

async function main(){
  const options = parsePublisherOptions(process.argv.slice(2))
  if(!process.env.AGENT_ARTIFACT_SIGNING_KEY_PEM||!process.env.AGENT_RELEASE_SIGNING_KEY_PEM)throw new Error('signing_keys_required')
  const manifests=[]
  for(const [platform,architecture] of TARGETS){
    const filename=`shellbeam-agent-${platform}-${architecture}`
    const bytes=await readFile(resolve(options.input,filename))
    manifests.push(signedRelease({bytes,version:options.version,platform,architecture,url:`${options.base}/${filename}`,channel:options.channel,rolloutPercentage:options.rolloutPercentage,previousSha256:options.previousHashes[filename],artifactKey:process.env.AGENT_ARTIFACT_SIGNING_KEY_PEM,releaseKey:process.env.AGENT_RELEASE_SIGNING_KEY_PEM}))
  }
  await mkdir(resolve(options.output,'..'),{recursive:true});await writeFile(options.output,JSON.stringify({schemaVersion:1,manifests},null,2)+'\n',{mode:0o644})
  console.log(`Signed ${manifests.length} artifacts into ${basename(options.output)}`)
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)await main()
