import { readFileSync, statSync } from 'node:fs'
import { OFFICIAL_BASE } from '../../src/main/marketplace/validation'

const filename = process.env.OC_CHAN_SMOKE_CONFIG
if (!filename || process.env.OC_CHAN_HEADLESS !== '1' || !process.env.OC_CHAN_DEV_INSTANCE || statSync(filename).size > 128 * 1024)
  throw new Error('Marketplace smoke requires the isolated headless launcher')
const config = JSON.parse(readFileSync(filename, 'utf8'))
const base = new URL(config.smoke.marketplaceFeed)
if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1' || base.username || base.password || base.pathname !== '/' || base.search || base.hash)
  throw new Error('Marketplace smoke feed must be a loopback HTTP server')

export function smokeMarketFetch(input, options) {
  const url = String(input)
  if (!url.startsWith(OFFICIAL_BASE) || !/^[a-zA-Z0-9._-]+$/.test(url.slice(OFFICIAL_BASE.length)))
    throw new Error('Unexpected marketplace smoke request')
  return fetch(new URL(url.slice(OFFICIAL_BASE.length), base), options)
}
