import type { SpalaPrincipal } from './spalaApi.js';

export type StartupSuggestedDefaults = {
  firstName?: string;
  lastName?: string;
  companyName?: string;
  projectName?: string;
};

export const DEFAULT_FIRST_PROJECT_NAME = 'My first app';

// Registrable labels of consumer mailbox providers. A mailbox provider is never a company name.
export const FREE_MAIL_DOMAIN_LABELS: ReadonlySet<string> = new Set([
  'gmail', 'googlemail', 'outlook', 'hotmail', 'live', 'msn', 'yahoo', 'ymail', 'rocketmail',
  'icloud', 'me', 'mac', 'proton', 'protonmail', 'pm', 'gmx', 'mail', 'email', 'inbox',
  'yandex', 'ya', 'ukr', 'i', 'meta', 'bigmir', 'rambler', 'aol', 'zoho', 'fastmail', 'hey',
  'tutanota', 'tuta', 'tutamail', 'duck', 'web', 'qq', '163', '126',
  // Microsoft and Google consumer aliases
  'windowslive', 'passport', 'outlook365', 'hotmail365',
  // Internet providers that hand out personal mailboxes
  'comcast', 'verizon', 'att', 'sbcglobal', 'bellsouth', 'cox', 'charter', 'spectrum', 'earthlink',
  'optonline', 'frontier', 'centurylink', 'shaw', 'rogers', 'telus', 'bell', 'sympatico', 'bigpond',
  'optusnet', 'btinternet', 'sky', 'virginmedia', 'talktalk', 'blueyonder', 'ntlworld', 'orange',
  'wanadoo', 'free', 'laposte', 'sfr', 't-online', 'freenet', 'arcor', 'libero', 'virgilio', 'tiscali',
  'alice', 'telenet', 'skynet', 'ziggo', 'kpnmail', 'bluewin', 'seznam', 'centrum', 'wp', 'o2', 'onet',
  'interia', 'abv', 'online', 'list', 'bk', 'naver', 'daum', 'hanmail', 'sina', 'sohu', 'yeah', '139',
  'rediffmail', 'terra', 'uol', 'bol',
  // Privacy and forwarding mailboxes
  'hushmail', 'mailfence', 'posteo', 'mailbox', 'startmail', 'runbox', 'pobox', 'simplelogin',
  'anonaddy', 'addy', 'privaterelay', 'disroot', 'riseup', 'cock',
  // Disposable mailboxes
  'mailinator', 'guerrillamail', 'tempmail', 'temp-mail', '10minutemail', 'yopmail', 'sharklasers',
  'trashmail', 'getnada', 'maildrop', 'dispostable', 'throwawaymail',
]);

// Schools and universities give people mailboxes; a student is not the institution.
const ACADEMIC_SUFFIXES: ReadonlySet<string> = new Set(['edu', 'ac', 'sch', 'k12']);

const SECOND_LEVEL_SUFFIXES: ReadonlySet<string> = new Set(['co', 'com', 'org', 'net', 'gov', 'edu', 'ac']);

// Shared mailboxes such as sales.team@ are not a person's name.
const ROLE_MAILBOX_WORDS: ReadonlySet<string> = new Set([
  'info', 'admin', 'sales', 'support', 'team', 'hello', 'contact', 'office', 'mail', 'email',
  'no', 'reply', 'noreply', 'dev', 'test', 'billing', 'hr', 'marketing', 'accounts', 'service',
]);

const MAX_FIELD_LENGTH = 120;

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}

function splitEmail(email: string | undefined): { local: string; domain: string } | undefined {
  const value = email?.trim() || '';
  const at = value.lastIndexOf('@');
  if (at <= 0 || at === value.length - 1) return undefined;
  return { local: value.slice(0, at), domain: value.slice(at + 1).toLowerCase() };
}

function emailNamePair(local: string): [string, string] | undefined {
  const parts = local.split('+')[0]!.split(/[._]/);
  if (parts.length !== 2) return undefined;
  if (!parts.every(part => /^\p{L}{2,}$/u.test(part) && !ROLE_MAILBOX_WORDS.has(part.toLowerCase()))) return undefined;
  return [capitalize(parts[0]!), capitalize(parts[1]!)];
}

function displayNamePair(name: string | undefined): [string, string] | undefined {
  const parts = (name || '').trim().split(/\s+/);
  if (parts.length !== 2 || parts.some(part => !/^\p{L}[\p{L}'’-]*$/u.test(part))) return undefined;
  return [parts[0]!, parts[1]!];
}

function sameName(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

function registrableDomainLabel(domain: string): string | undefined {
  const labels = domain.split('.').filter(Boolean);
  if (labels.length < 2) return undefined;
  const topLevel = labels.pop()!;
  if (labels.length > 1 && topLevel.length === 2 && SECOND_LEVEL_SUFFIXES.has(labels[labels.length - 1]!)) labels.pop();
  return labels[labels.length - 1];
}

function companyFromDomain(domain: string, firstName: string | undefined): string | undefined {
  const label = registrableDomainLabel(domain);
  if (!label) return undefined;
  const personalMailbox = FREE_MAIL_DOMAIN_LABELS.has(label) || domain.split('.').slice(1).some(part => ACADEMIC_SUFFIXES.has(part));
  if (personalMailbox) return firstName ? `${firstName}'s workspace` : undefined;
  if (!/^[a-z][a-z0-9-]+$/.test(label) || label.startsWith('xn--')) return undefined;
  return label.split('-').filter(Boolean).map(capitalize).join(' ');
}

/**
 * Derives proposals for the missing startup values from the verified principal only.
 * A value that cannot be derived confidently is omitted. These are proposals for the
 * user to confirm or correct; nothing here is written anywhere.
 */
export function deriveStartupDefaults(
  principal: SpalaPrincipal,
  options: { projectCount?: number } = {},
): StartupSuggestedDefaults {
  const user = principal.user;
  const knownFirst = user.firstName?.trim() || undefined;
  const knownLast = user.lastName?.trim() || undefined;
  const email = splitEmail(user.email);
  const pairs = [displayNamePair(user.name), email ? emailNamePair(email.local) : undefined]
    .filter((pair): pair is [string, string] => Boolean(pair));

  let firstName: string | undefined;
  let lastName: string | undefined;
  if (!knownFirst && !knownLast) {
    [firstName, lastName] = pairs[0] || [];
  } else if (!knownLast && knownFirst) {
    const pair = pairs.find(candidate => candidate.some(part => sameName(part, knownFirst)));
    lastName = pair && (sameName(pair[0], knownFirst) ? pair[1] : pair[0]);
  } else if (!knownFirst && knownLast) {
    const pair = pairs.find(candidate => candidate.some(part => sameName(part, knownLast)));
    firstName = pair && (sameName(pair[1], knownLast) ? pair[0] : pair[1]);
  }

  const companyName = principal.organizations.length === 0 && email
    ? companyFromDomain(email.domain, knownFirst || firstName)
    : undefined;

  const fits = (value: string | undefined): value is string => Boolean(value) && value!.length <= MAX_FIELD_LENGTH;
  return {
    ...(fits(firstName) ? { firstName } : {}),
    ...(fits(lastName) ? { lastName } : {}),
    ...(fits(companyName) ? { companyName } : {}),
    ...(options.projectCount === 0 ? { projectName: DEFAULT_FIRST_PROJECT_NAME } : {}),
  };
}
