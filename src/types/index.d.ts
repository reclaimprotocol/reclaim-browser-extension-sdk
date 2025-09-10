export interface InitOptions {
  extensionID?: string;
  providerVersion?: string;
  callbackUrl?: string;
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

  static fromJsonString(json: string | Record<string, unknown>, options?: InitOptions): ReclaimExtensionProofRequest;
  static fromConfig(config: Record<string, unknown>, options?: InitOptions): ReclaimExtensionProofRequest;

  setAppCallbackUrl(url: string, jsonProofResponse?: boolean): void;
  setRedirectUrl(url: string): void;
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
  init(
    applicationId: string,
    appSecret: string,
    providerId: string,
    options?: InitOptions,
  ): Promise<ReclaimExtensionProofRequest>;

  // Convenience wrapper that forwards to ReclaimExtensionProofRequest.fromJsonString
  fromJsonString(json: string | Record<string, unknown>, options?: InitOptions): ReclaimExtensionProofRequest;
}

export const reclaimExtensionSDK: ReclaimExtensionSDK;
export default ReclaimExtensionSDK;