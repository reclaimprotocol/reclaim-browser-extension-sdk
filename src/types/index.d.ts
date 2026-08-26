export interface InitOptions {
  extensionID?: string;
  providerVersion?: string;
  callbackUrl?: string;
}

export interface BuilderClaimantDetails {
  /** Keep this string to 64 characters or fewer. */
  locale?: string;
  /** Keep this string to 64 characters or fewer. */
  timezone?: string;
  /** Keep this string to 64 characters or fewer. */
  platform?: string;
  /** Keep this string to 256 characters or fewer. */
  userAgent?: string;
  /** Use integer CSS-pixel dimensions from 0 through 10,000. */
  viewport?: { width: number; height: number };
}

/** Builder-specific options. Legacy provider and callback options are ignored. */
export interface BuilderInitOptions extends InitOptions {
  /** Registered Builder Verification Client UUID. */
  verificationClientId: string;
  /** Stable per-installation claimant UUID; generated and stored when omitted. */
  claimantClientId?: string;
  /** HTTPS origin exposing `/api/sdk/builder/v2`; defaults to Reclaim's API. */
  backendUrl?: string;
  /** Optional bounded claimant diagnostics sent to the Builder bridge. */
  claimantDetails?: BuilderClaimantDetails;
}

export interface VerificationUrl {
  /** Missing or unknown API versions return `legacy`; only exact `api=2` is Builder. */
  mode: "legacy" | "builder";
  /** Present only for a Builder URL with a non-empty sessionId. */
  sessionId?: string;
  url: URL;
}

export interface Proofs {
  [key: string]: unknown;
}

export type RequestEvents = "started" | "completed" | "error" | "progress";

export class ReclaimExtensionProofRequest {
  applicationId: string;
  providerId: string;
  sessionId: string;
  signature: string;
  timestamp: string;
  getStatusUrl(): string;

  static fromJsonString(
    json: string | Record<string, unknown>,
    options?: InitOptions,
  ): ReclaimExtensionProofRequest;
  static fromConfig(
    config: Record<string, unknown>,
    options?: InitOptions,
  ): ReclaimExtensionProofRequest;
  /** Rejects legacy URLs instead of reinterpreting their legacy parameters. */
  static fromVerificationUrl(
    url: string | URL,
    options: BuilderInitOptions,
  ): ReclaimExtensionProofRequest;

  setAppCallbackUrl(url: string, jsonProofResponse?: boolean): void;
  setRedirectUrl(url: string): void;
  setContext(address: string, message: string): void;
  setJsonContext(address: string, jsonObj: Record<string, unknown>): void;
  /** @deprecated Use setContext() instead */
  addContext(address: string | number, message: string): void;
  setParams(params: Record<string, unknown>): void;

  on(event: RequestEvents, cb: (payload?: unknown) => void): () => void;
  off(event: RequestEvents, cb: (payload?: unknown) => void): void;

  startVerification(): Promise<Proofs>;
  cancel(timeoutMs?: number): Promise<boolean | void>;
}

export class ReclaimExtensionSDK {
  initializeBackground(): unknown;
  isExtensionInstalled(opts?: { extensionID?: string; timeout?: number }): Promise<boolean>;
  getVersion(): string;
  parseVerificationUrl(verificationUrl: string | URL): VerificationUrl;
  init(
    applicationId: string,
    appSecret: string,
    providerId: string,
    options?: InitOptions,
  ): Promise<ReclaimExtensionProofRequest>;

  // Convenience wrapper that forwards to ReclaimExtensionProofRequest.fromJsonString
  fromJsonString(
    json: string | Record<string, unknown>,
    options?: InitOptions,
  ): ReclaimExtensionProofRequest;
  /** Parses only an exact `api=2` URL with a non-empty sessionId. */
  fromVerificationUrl(
    verificationUrl: string | URL,
    options: BuilderInitOptions,
  ): ReclaimExtensionProofRequest;
  /** Convenience async entry point for Builder `api=2` launch URLs. */
  initBuilder(
    verificationUrl: string | URL,
    options: BuilderInitOptions,
  ): Promise<ReclaimExtensionProofRequest>;
}

export const reclaimExtensionSDK: ReclaimExtensionSDK;
export default ReclaimExtensionSDK;
