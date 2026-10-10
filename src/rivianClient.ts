import crypto from 'node:crypto';

// Overridable so tests can point the client at a local mock server.
const GRAPHQL_GATEWAY = process.env.RIVIAN_GRAPHQL_URL || 'https://rivian.com/api/gql/gateway/graphql';
const APOLLO_CLIENT_NAME = 'com.rivian.ios.consumer-apollo-ios';
const REQUEST_TIMEOUT_MS = 20_000;

export interface RivianTokens {
  accessToken: string;
  refreshToken: string;
  userSessionToken: string;
}

export interface RivianVehicle {
  id: string;
  vin: string;
  name: string;
  make?: string;
  model?: string;
  modelYear?: number;
}

export type RawVehicleState = Record<string, { timeStamp: string; value: unknown } | null>;

export class RivianApiError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
    this.name = 'RivianApiError';
  }

  get isAuthError(): boolean {
    return this.code === 'UNAUTHENTICATED' || this.code === 'SESSION_MANAGER_ERROR';
  }
}

/**
 * Minimal client for Rivian's unofficial GraphQL API, limited to sign-in and
 * reading vehicle state. It never sends vehicle commands, so it needs no
 * phone key and works the same for Gen1 and Gen2 vehicles.
 */
export class RivianClient {
  private csrfToken = '';
  private appSessionToken = '';
  private otpToken = '';
  private tokens: RivianTokens = { accessToken: '', refreshToken: '', userSessionToken: '' };

  constructor(tokens?: RivianTokens) {
    if (tokens) {
      this.tokens = { ...tokens };
    }
  }

  getTokens(): RivianTokens {
    return { ...this.tokens };
  }

  private async graphql<T>(headers: Record<string, string>, body: object): Promise<T> {
    let response: Response;
    try {
      response = await fetch(GRAPHQL_GATEWAY, {
        method: 'POST',
        headers: {
          'User-Agent': 'RivianApp/707 CFNetwork/1237 Darwin/20.4.0',
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'Apollographql-Client-Name': APOLLO_CLIENT_NAME,
          'dc-cid': `m-ios-${crypto.randomUUID()}`,
          ...headers,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw new RivianApiError(`Network error talking to Rivian: ${(err as Error).message}`);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let json: any;
    try {
      json = await response.json();
    } catch {
      throw new RivianApiError(`Rivian returned a non-JSON response (HTTP ${response.status})`);
    }

    // GraphQL can return partial data alongside errors (e.g. one unknown
    // state field). Only fail when there is no data to use.
    if (Array.isArray(json?.errors) && json.errors.length && !json.data) {
      const first = json.errors[0];
      const code: string | undefined = first?.extensions?.code;
      const reason: string | undefined = first?.extensions?.reason;
      const message = first?.message || code || 'Unknown Rivian API error';
      throw new RivianApiError(`${message}${reason ? ` (${reason})` : ''}`, code);
    }
    if (!json?.data) {
      throw new RivianApiError(`Rivian returned no data (HTTP ${response.status})`);
    }
    return json.data as T;
  }

  /** Gets a fresh CSRF and app session token. Call before anything else. */
  async createSession(): Promise<void> {
    const data = await this.graphql<{ createCsrfToken: { csrfToken: string; appSessionToken: string } }>({}, {
      operationName: 'CreateCSRFToken',
      query: 'mutation CreateCSRFToken { createCsrfToken { __typename csrfToken appSessionToken } }',
      variables: null,
    });
    this.csrfToken = data.createCsrfToken.csrfToken;
    this.appSessionToken = data.createCsrfToken.appSessionToken;
  }

  /** Signs in with email and password. Returns whether a one-time code is needed. */
  async login(email: string, password: string): Promise<{ otpRequired: boolean }> {
    if (!this.csrfToken) {
      await this.createSession();
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = await this.graphql<{ login: any }>({ 'Csrf-Token': this.csrfToken, 'A-Sess': this.appSessionToken }, {
      operationName: 'Login',
      query: 'mutation Login($email: String!, $password: String!) { login(email: $email, password: $password) { __typename ... on MobileLoginResponse { __typename accessToken refreshToken userSessionToken } ... on MobileMFALoginResponse { __typename otpToken } } }',
      variables: { email, password },
    });
    if (data.login?.otpToken) {
      this.otpToken = data.login.otpToken;
      return { otpRequired: true };
    }
    this.setTokens(data.login);
    return { otpRequired: false };
  }

  /** Finishes sign-in for MFA accounts with the code Rivian texted or emailed. */
  async loginWithOtp(email: string, otpCode: string): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = await this.graphql<{ loginWithOTP: any }>({ 'Csrf-Token': this.csrfToken, 'A-Sess': this.appSessionToken }, {
      operationName: 'LoginWithOTP',
      query: 'mutation LoginWithOTP($email: String!, $otpCode: String!, $otpToken: String!) { loginWithOTP(email: $email, otpCode: $otpCode, otpToken: $otpToken) { __typename ... on MobileLoginResponse { __typename accessToken refreshToken userSessionToken } } }',
      variables: { email, otpCode, otpToken: this.otpToken },
    });
    this.setTokens(data.loginWithOTP);
  }

  private setTokens(login: Partial<RivianTokens> | undefined): void {
    if (!login?.userSessionToken) {
      throw new RivianApiError('Rivian did not return a session token.');
    }
    this.tokens = {
      accessToken: login.accessToken ?? '',
      refreshToken: login.refreshToken ?? '',
      userSessionToken: login.userSessionToken,
    };
  }

  private authedHeaders(): Record<string, string> {
    return { 'A-Sess': this.appSessionToken, 'U-Sess': this.tokens.userSessionToken };
  }

  async getVehicles(): Promise<RivianVehicle[]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = await this.graphql<{ currentUser: any }>(this.authedHeaders(), {
      operationName: 'getUserInfo',
      query: 'query getUserInfo { currentUser { __typename id vehicles { id vin name vehicle { __typename id vin modelYear make model } } } }',
      variables: null,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (data.currentUser?.vehicles ?? []).map((v: any) => ({
      id: v.id,
      vin: v.vin,
      name: v.name || v.vehicle?.model || 'Rivian',
      make: v.vehicle?.make,
      model: v.vehicle?.model,
      modelYear: v.vehicle?.modelYear,
    }));
  }

  /** Reads the cloud's last-known vehicle state. This does not wake the vehicle. */
  async getVehicleState(vehicleId: string, properties: readonly string[]): Promise<RawVehicleState> {
    const fields = properties.map((p) => `${p} { timeStamp value }`).join(' ');
    const data = await this.graphql<{ vehicleState: RawVehicleState | null }>(this.authedHeaders(), {
      operationName: 'GetVehicleState',
      query: `query GetVehicleState($vehicleID: String!) { vehicleState(id: $vehicleID) { ${fields} } }`,
      variables: { vehicleID: vehicleId },
    });
    if (!data.vehicleState) {
      throw new RivianApiError(`No state returned for vehicle ${vehicleId}`);
    }
    return data.vehicleState;
  }
}
