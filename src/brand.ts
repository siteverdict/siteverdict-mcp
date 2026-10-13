import { readFileSync } from 'node:fs';

/**
 * Brand constant. The ONLY place the brand is defined is ../brand.json (shipped
 * in the npm package next to dist/). Rename the product by editing brand.json
 * and running `npm run brand:sync`.
 */
export interface Brand {
  name: string;
  displayName: string;
  slug: string;
  npmPackage: string;
  binName: string;
  registryName: string;
  githubOwner: string;
  githubRepo: string;
  apifyUsername: string;
  actorPrefix: string;
  website: string;
  supportEmail: string;
  uriScheme: string;
  tagline: string;
  company: string;
  companyLocation: string;
  owner: string;
  /** Planned public Streamable HTTP endpoint (not deployed). */
  mcpPublicUrl: string;
}

function loadBrand(): Brand {
  const raw = readFileSync(new URL('../brand.json', import.meta.url), 'utf8');
  const parsed = JSON.parse(raw) as Partial<Brand>;
  const required: (keyof Brand)[] = [
    'name', 'displayName', 'slug', 'npmPackage', 'binName', 'registryName', 'githubOwner',
    'githubRepo', 'apifyUsername', 'actorPrefix', 'website', 'supportEmail', 'uriScheme', 'tagline',
    'company', 'companyLocation', 'owner', 'mcpPublicUrl',
  ];
  for (const key of required) {
    if (typeof parsed[key] !== 'string') throw new Error(`brand.json is missing "${key}"`);
  }
  return Object.freeze(parsed as Brand);
}

export const BRAND: Brand = loadBrand();

export const SERVER_VERSION: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();
