export { AuthenticationError, CsrfError, OriginError, RateLimitedError, SessionRevokedError } from './errors.ts';
export {
  claimedTenantIsNotMembership,
  guestPrincipal,
  systemPrincipal,
  toAuthActor,
  userPrincipal,
} from './principal.ts';
export type { AuthActor } from './principal.ts';
export {
  AuthService,
  BruteForceGuard,
  MemoryDirectoryStore,
  MemorySessionStore,
} from './service.ts';
export type { AuthServiceOptions, DirectoryStore, ResolvedAuth, SessionStore } from './service.ts';
export { MemoryCredentialStore, isUsableLoginId, normalizeLoginId } from './credentials.ts';
export type { CredentialStore, PrincipalCredential } from './credentials.ts';
export {
  LOGIN_IDENTIFIER_LIMIT,
  LOGIN_SOURCE_LIMIT,
  LOGIN_WINDOW_MS,
  LoginService,
  createMemoryLogin,
  selectTenant,
} from './login.ts';
export type { LoginServiceOptions, NativeLoginInput, NativeLoginResult } from './login.ts';
export {
  MIN_PASSWORD_LENGTH,
  PASSWORD_ALGO,
  ScryptPasswordHasher,
  assertProvisionPassword,
  defaultPasswordHasher,
  dummyVerify,
  isHashedPassword,
} from './password.ts';
export type { PasswordHasher } from './password.ts';
