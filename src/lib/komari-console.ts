import { normalizeKomariEndpoint } from './komari'

/** The saved endpoint is a server base URL, including any reverse-proxy path.
 * Never attach API credentials or reuse query/fragment state in the console. */
export function komariConsoleUrl(endpoint: string): string {
  const url = new URL(normalizeKomariEndpoint(endpoint))
  if (!url.pathname.endsWith('/')) url.pathname += '/'
  return url.toString()
}
