import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { UserInputError } from './errors.js';

/**
 * Target validation. Only public http(s) websites and public domain names are
 * accepted. Private, loopback, link-local, CGNAT, multicast, documentation and
 * reserved ranges are rejected (SSRF guard), both for IP literals and, when DNS
 * checking is on, for every address the hostname resolves to.
 */

const BLOCKED_SUFFIXES = [
  '.localhost', '.local', '.internal', '.intranet', '.lan', '.home', '.corp', '.private',
  '.home.arpa', '.localdomain', '.test', '.invalid', '.example', '.onion', '.arpa',
];
const BLOCKED_HOSTS = new Set(['localhost', 'metadata', 'metadata.google.internal', 'instance-data']);
const ALLOWED_PORTS = new Set(['', '80', '443', '8080', '8443']);
const MAX_URL_LENGTH = 2048;

function ipv4ToInt(ip: string): number {
  const parts = ip.split('.').map(Number);
  return (((parts[0]! << 24) >>> 0) + (parts[1]! << 16) + (parts[2]! << 8) + parts[3]!) >>> 0;
}

const V4_BLOCKS: [string, number][] = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];

export function isPrivateIPv4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  return V4_BLOCKS.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (n & mask) === (ipv4ToInt(base) & mask);
  });
}

function expandIPv6(ip: string): number[] | null {
  let addr = ip.toLowerCase();
  const zone = addr.indexOf('%');
  if (zone >= 0) addr = addr.slice(0, zone);
  // Embedded IPv4 tail (e.g. ::ffff:10.0.0.1)
  const v4 = addr.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const n = ipv4ToInt(v4[1]!);
    addr = addr.slice(0, -v4[1]!.length) + ((n >>> 16) & 0xffff).toString(16) + ':' + (n & 0xffff).toString(16);
  }
  const halves = addr.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  const groups = [...head, ...Array(Math.max(0, fill)).fill('0'), ...tail].map((g) => parseInt(g, 16));
  if (groups.length !== 8 || groups.some((g) => Number.isNaN(g))) return null;
  return groups;
}

export function isPrivateIPv6(ip: string): boolean {
  const g = expandIPv6(ip);
  if (!g) return true; // unparseable: treat as unsafe
  const [a, b] = [g[0]!, g[1]!];
  if (g.every((x) => x === 0)) return true; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1
  if ((a & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA
  if ((a & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((a & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
  if ((a & 0xff00) === 0xff00) return true; // multicast
  if (a === 0x2001 && b === 0x0db8) return true; // documentation
  if (a === 0x0064 && b === 0xff9b) return true; // NAT64 (may map to private v4)
  if (a === 0x2002) return true; // 6to4 can embed private v4
  if (a === 0x2001 && b === 0x0000) return true; // Teredo
  // IPv4-mapped / compatible
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) {
    const v4 = `${g[6]! >> 8}.${g[6]! & 0xff}.${g[7]! >> 8}.${g[7]! & 0xff}`;
    return isPrivateIPv4(v4);
  }
  return false;
}

export function isPrivateIp(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return isPrivateIPv4(ip);
  if (kind === 6) return isPrivateIPv6(ip);
  return true;
}

function checkHostname(hostname: string): void {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  const bare = host.startsWith('[') ? host.slice(1, -1) : host;
  if (isIP(bare)) {
    if (isPrivateIp(bare)) throw new UserInputError(`"${hostname}" is a private, loopback or reserved IP address. Only public websites can be audited.`);
    return;
  }
  if (BLOCKED_HOSTS.has(host) || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) {
    throw new UserInputError(`"${hostname}" is an internal or reserved hostname. Only public websites can be audited.`);
  }
  if (!host.includes('.')) throw new UserInputError(`"${hostname}" is not a fully-qualified public domain name.`);
  if (host.length > 253 || !/^[a-z0-9.-]+$/.test(host) || host.split('.').some((l) => l.length === 0 || l.length > 63 || l.startsWith('-') || l.endsWith('-'))) {
    throw new UserInputError(`"${hostname}" is not a valid domain name.`);
  }
  const tld = host.split('.').pop()!;
  if (/^\d+$/.test(tld)) throw new UserInputError(`"${hostname}" is not a valid domain name.`);
}

export type Resolver = (host: string) => Promise<string[]>;

export const systemResolver: Resolver = async (host) => {
  const records = await dnsLookup(host, { all: true, verbatim: true });
  return records.map((r) => r.address);
};

async function checkResolves(host: string, resolver: Resolver): Promise<void> {
  const bare = host.startsWith('[') ? host.slice(1, -1) : host;
  if (isIP(bare)) return;
  let addresses: string[];
  try {
    addresses = await resolver(bare);
  } catch {
    throw new UserInputError(`The domain "${bare}" does not resolve in public DNS. Check the spelling.`);
  }
  if (addresses.length === 0) throw new UserInputError(`The domain "${bare}" has no A/AAAA records.`);
  const bad = addresses.find((a) => isPrivateIp(a));
  if (bad) throw new UserInputError(`The domain "${bare}" resolves to a private or reserved address (${bad}). Only public websites can be audited.`);
}

export interface ValidateOptions {
  dnsCheck: boolean;
  resolver?: Resolver;
}

/** Normalises and validates a website URL. Bare domains get https:// prepended. */
export async function validatePublicUrl(input: string, opts: ValidateOptions): Promise<string> {
  const raw = input.trim();
  if (!raw) throw new UserInputError('A website URL is required, e.g. https://example.com');
  if (raw.length > MAX_URL_LENGTH) throw new UserInputError(`URL is longer than ${MAX_URL_LENGTH} characters.`);
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new UserInputError(`"${input}" is not a valid URL. Use a public address like https://example.com`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new UserInputError(`Only http(s) URLs are supported (got "${url.protocol}").`);
  if (url.username || url.password) throw new UserInputError('URLs containing credentials are not allowed.');
  if (!ALLOWED_PORTS.has(url.port)) throw new UserInputError(`Port ${url.port} is not allowed. Use the site's public http(s) port.`);
  checkHostname(url.hostname);
  if (opts.dnsCheck) await checkResolves(url.hostname, opts.resolver ?? systemResolver);
  url.hash = '';
  return url.toString();
}

/** Accepts a domain or a URL and returns the registrable hostname (lower-case, no www. stripping). */
export async function validatePublicDomain(input: string, _opts: ValidateOptions): Promise<string> {
  const raw = input.trim();
  if (!raw) throw new UserInputError('A domain is required, e.g. example.com');
  let host = raw;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) || raw.includes('/')) {
    try {
      host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`).hostname;
    } catch {
      throw new UserInputError(`"${input}" is not a valid domain.`);
    }
  }
  if (host.includes('@')) host = host.split('@').pop()!; // allow an email address
  host = host.toLowerCase().replace(/\.$/, '');
  try {
    host = new URL(`https://${host}`).hostname; // punycode IDNs
  } catch {
    throw new UserInputError(`"${input}" is not a valid domain.`);
  }
  if (isIP(host.replace(/^\[|\]$/g, ''))) throw new UserInputError('Give a domain name, not an IP address.');
  checkHostname(host);
  // Domain checks query DNS (MX/SPF/DMARC), so the apex need not have A records: no resolve check here.
  return host;
}
