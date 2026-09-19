import { isIP } from 'node:net';

export function isPrivateIpv4(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }
  const [a, b] = parts as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  );
}

export function isPrivateIpv6(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized.startsWith('::ffff:')) {
    const mapped = normalized.slice('::ffff:'.length);
    if (isIP(mapped) === 4) return isPrivateIpv4(mapped);
  }
  const encoded = encodedIpv4(normalized);
  if (encoded) return isPrivateIpv4(encoded);
  return (
    normalized === '::' ||
    normalized === '::1' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('fe8') ||
    normalized.startsWith('fe9') ||
    normalized.startsWith('fea') ||
    normalized.startsWith('feb') ||
    normalized.startsWith('ff')
  );
}

export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPrivateIpv4(address);
  if (family === 6) return isPrivateIpv6(address);
  return true;
}

export function assertPublicHttpUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('URL is invalid.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only http and https URLs are permitted.');
  }
  if (url.username || url.password) {
    throw new Error('URLs containing credentials are not permitted.');
  }
  const hostname = url.hostname.toLowerCase();
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname === 'metadata.google.internal'
  ) {
    throw new Error('Local-network hosts are not permitted.');
  }
  const literalFamily = isIP(hostname);
  if (literalFamily > 0 && isPrivateAddress(hostname)) {
    throw new Error('Private or reserved network addresses are not permitted.');
  }
  return url;
}

function encodedIpv4(address: string): string | null {
  const groups = ipv6Groups(address);
  if (!groups) return null;
  const octet = (group: number): [number, number] => [group >> 8, group & 0xff];
  if (groups[0] === 0x2002) {
    const [a, b] = octet(groups[1] ?? 0);
    const [c, d] = octet(groups[2] ?? 0);
    return `${a}.${b}.${c}.${d}`;
  }
  if (
    groups[0] === 0x64 &&
    groups[1] === 0xff9b &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    groups[5] === 0
  ) {
    const [a, b] = octet(groups[6] ?? 0);
    const [c, d] = octet(groups[7] ?? 0);
    return `${a}.${b}.${c}.${d}`;
  }
  return null;
}

function ipv6Groups(address: string): number[] | null {
  let addr = address.trim().toLowerCase();
  const zone = addr.indexOf('%');
  if (zone >= 0) addr = addr.slice(0, zone);
  if (addr.startsWith('[') && addr.endsWith(']')) addr = addr.slice(1, -1);
  const dotted = addr.match(/^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted) {
    const ipv4 = dotted[2];
    if (!ipv4) return null;
    const parts = ipv4.split('.').map((item) => Number(item));
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    const hi = ((parts[0] ?? 0) << 8) | (parts[1] ?? 0);
    const lo = ((parts[2] ?? 0) << 8) | (parts[3] ?? 0);
    addr = `${dotted[1] ?? ''}${hi.toString(16)}:${lo.toString(16)}`;
  }
  const parse = (value: string): number[] | null => {
    if (!value) return [];
    const parts = value.split(':');
    if (parts.some((part) => !part || /[^0-9a-f]/.test(part) || part.length > 4)) return null;
    const groups = parts.map((part) => parseInt(part, 16));
    if (groups.some((n) => !Number.isInteger(n) || n < 0 || n > 0xffff)) return null;
    return groups;
  };
  if (addr.includes('::')) {
    const pieces = addr.split('::');
    if (pieces.length !== 2) return null;
    const left = parse(pieces[0] ?? '');
    const right = parse(pieces[1] ?? '');
    if (!left || !right) return null;
    const fill = 8 - left.length - right.length;
    if (fill < 0) return null;
    return [...left, ...Array(fill).fill(0), ...right];
  }
  const groups = parse(addr);
  return groups?.length === 8 ? groups : null;
}
