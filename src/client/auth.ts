import pkceChallenge from "pkce-challenge";
import { LATEST_PROTOCOL_VERSION } from "../types.js";
import type {
  OAuthClientInformation,
  OAuthClientInformationFull,
  OAuthClientMetadata,
  OAuthMetadata,
  OAuthProtectedResourceMetadata,
  OAuthTokens,
} from "../shared/auth.js";
import {
  OAuthClientInformationFullSchema,
  OAuthMetadataSchema,
  OAuthProtectedResourceMetadataSchema,
  OAuthTokensSchema,
} from "../shared/auth.js";
import {
  checkResourceAllowed,
  resourceUrlFromServerUrl,
} from "../shared/auth-utils.js";

/**
 * Implements an end-to-end OAuth client to be used with one MCP server.
 *
 * This client relies upon a concept of an authorized "session," the exact
 * meaning of which is application-defined. Tokens, authorization codes, and
 * code verifiers should not cross different sessions.
 */
export interface OAuthClientProvider {
  /**
   * The URL to redirect the user agent to after authorization.
   */
  get redirectUrl(): string | URL;

  /**
   * Metadata about this OAuth client.
   */
  get clientMetadata(): OAuthClientMetadata;

  /**
   * Returns a OAuth2 state parameter.
   */
  state?(): string | Promise<string>;

  /**
   * Loads information about this OAuth client, as registered already with the
   * server, or returns `undefined` if the client is not registered with the
   * server.
   */
  clientInformation():
    | OAuthClientInformation
    | undefined
    | Promise<OAuthClientInformation | undefined>;

  /**
   * If implemented, this permits the OAuth client to dynamically register with
   * the server. Client information saved this way should later be read via
   * `clientInformation()`.
   *
   * This method is not required to be implemented if client information is
   * statically known (e.g., pre-registered).
   */
  saveClientInformation?(
    clientInformation: OAuthClientInformationFull,
  ): void | Promise<void>;

  /**
   * Loads any existing OAuth tokens for the current session, or returns
   * `undefined` if there are no saved tokens.
   */
  tokens(): OAuthTokens | undefined | Promise<OAuthTokens | undefined>;

  /**
   * Stores new OAuth tokens for the current session, after a successful
   * authorization.
   */
  saveTokens(tokens: OAuthTokens): void | Promise<void>;

  /**
   * Invoked to redirect the user agent to the given URL to begin the authorization flow.
   */
  redirectToAuthorization(authorizationUrl: URL): void | Promise<void>;

  /**
   * Saves a PKCE code verifier for the current session, before redirecting to
   * the authorization flow.
   */
  saveCodeVerifier(codeVerifier: string): void | Promise<void>;

  /**
   * Loads the PKCE code verifier for the current session, necessary to validate
   * the authorization result.
   */
  codeVerifier(): string | Promise<string>;

  /**
   * If defined, overrides the selection and validation of the
   * RFC 8707 Resource Indicator. If left undefined, default
   * validation behavior will be used.
   *
   * Implementations must verify the returned resource matches the MCP server.
   */
  validateResourceURL?(
    serverUrl: string | URL,
    resource?: string,
  ): Promise<URL | undefined>;
}

export type AuthResult = "AUTHORIZED" | "REDIRECT";

export class UnauthorizedError extends Error {
  constructor(message?: string) {
    super(message ?? "Unauthorized");
  }
}

/**
 * Orchestrates the full auth flow with a server.
 *
 * This can be used as a single entry point for all authorization functionality,
 * instead of linking together the other lower-level functions in this module.
 */
export async function auth(
  provider: OAuthClientProvider,
  { serverUrl, authorizationCode, scope, resourceMetadataUrl }: {
    serverUrl: string | URL;
    authorizationCode?: string;
    scope?: string;
    resourceMetadataUrl?: URL;
  },
): Promise<AuthResult> {
  let resourceMetadata: OAuthProtectedResourceMetadata | undefined;
  let authorizationServerUrl = serverUrl;
  try {
    resourceMetadata = await discoverOAuthProtectedResourceMetadata(serverUrl, {
      resourceMetadataUrl,
    });
    if (
      resourceMetadata.authorization_servers &&
      resourceMetadata.authorization_servers.length > 0
    ) {
      authorizationServerUrl = resourceMetadata.authorization_servers[0];
    }
  } catch {
    // Ignore errors and fall back to /.well-known/oauth-authorization-server
  }

  const resource: URL | undefined = await selectResourceURL(
    serverUrl,
    provider,
    resourceMetadata,
  );

  const metadata = await discoverOAuthMetadata(authorizationServerUrl);

  // Handle client registration if needed
  let clientInformation = await Promise.resolve(provider.clientInformation());
  if (!clientInformation) {
    if (authorizationCode !== undefined) {
      throw new Error(
        "Existing OAuth client information is required when exchanging an authorization code",
      );
    }

    if (!provider.saveClientInformation) {
      throw new Error(
        "OAuth client information must be saveable for dynamic registration",
      );
    }

    const fullInformation = await registerClient(authorizationServerUrl, {
      metadata,
      clientMetadata: provider.clientMetadata,
    });

    await provider.saveClientInformation(fullInformation);
    clientInformation = fullInformation;
  }

  // Exchange authorization code for tokens
  if (authorizationCode !== undefined) {
    const codeVerifier = await provider.codeVerifier();
    const tokens = await exchangeAuthorization(authorizationServerUrl, {
      metadata,
      clientInformation,
      authorizationCode,
      codeVerifier,
      redirectUri: provider.redirectUrl,
      resource,
    });

    await provider.saveTokens(tokens);
    return "AUTHORIZED";
  }

  const tokens = await provider.tokens();

  // Handle token refresh or new authorization
  if (tokens?.refresh_token) {
    try {
      // Attempt to refresh the token
      const newTokens = await refreshAuthorization(authorizationServerUrl, {
        metadata,
        clientInformation,
        refreshToken: tokens.refresh_token,
        resource,
      });

      await provider.saveTokens(newTokens);
      return "AUTHORIZED";
    } catch {
      // Could not refresh OAuth tokens
    }
  }

  const state = provider.state ? await provider.state() : undefined;

  // Start new authorization flow
  const { authorizationUrl, codeVerifier } = await startAuthorization(
    authorizationServerUrl,
    {
      metadata,
      clientInformation,
      state,
      redirectUrl: provider.redirectUrl,
      scope: scope || provider.clientMetadata.scope,
      resource,
    },
  );

  await provider.saveCodeVerifier(codeVerifier);
  await provider.redirectToAuthorization(authorizationUrl);
  return "REDIRECT";
}

export async function selectResourceURL(
  serverUrl: string | URL,
  provider: OAuthClientProvider,
  resourceMetadata?: OAuthProtectedResourceMetadata,
): Promise<URL | undefined> {
  const defaultResource = resourceUrlFromServerUrl(serverUrl);

  // If provider has custom validation, delegate to it
  if (provider.validateResourceURL) {
    return await provider.validateResourceURL(
      defaultResource,
      resourceMetadata?.resource,
    );
  }

  // Only include resource parameter when Protected Resource Metadata is present
  if (!resourceMetadata) {
    return undefined;
  }

  // Validate that the metadata's resource is compatible with our request
  if (
    !checkResourceAllowed({
      requestedResource: defaultResource,
      configuredResource: resourceMetadata.resource,
    })
  ) {
    throw new Error(
      `Protected resource ${resourceMetadata.resource} does not match expected ${defaultResource} (or origin)`,
    );
  }
  // Prefer the resource from metadata since it's what the server is telling us to request
  return new URL(resourceMetadata.resource);
}

/**
 * Extract resource_metadata from response header.
 */
export function extractResourceMetadataUrl(res: Response): URL | undefined {
  const authenticateHeader = res.headers.get("WWW-Authenticate");
  if (!authenticateHeader) {
    return undefined;
  }

  const [type, scheme] = authenticateHeader.split(" ");
  if (type.toLowerCase() !== "bearer" || !scheme) {
    return undefined;
  }
  const regex = /resource_metadata="([^"]*)"/;
  const match = regex.exec(authenticateHeader);

  if (!match) {
    return undefined;
  }

  try {
    return new URL(match[1]);
  } catch {
    return undefined;
  }
}

/**
 * Looks up RFC 9728 OAuth 2.0 Protected Resource Metadata.
 *
 * If the server returns a 404 for the well-known endpoint, this function will
 * return `undefined`. Any other errors will be thrown as exceptions.
 */
export async function discoverOAuthProtectedResourceMetadata(
  serverUrl: string | URL,
  opts?: { protocolVersion?: string; resourceMetadataUrl?: string | URL },
): Promise<OAuthProtectedResourceMetadata> {
  let url: URL;
  if (opts?.resourceMetadataUrl) {
    url = new URL(opts?.resourceMetadataUrl);
  } else {
    url = new URL("/.well-known/oauth-protected-resource", serverUrl);
  }

  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        "MCP-Protocol-Version": opts?.protocolVersion ??
          LATEST_PROTOCOL_VERSION,
      },
    });
  } catch (error) {
    // CORS errors come back as TypeError
    if (error instanceof TypeError) {
      response = await fetch(url);
    } else {
      throw error;
    }
  }

  if (response.status === 404) {
    throw new Error(
      `Resource server does not implement OAuth 2.0 Protected Resource Metadata.`,
    );
  }

  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status} trying to load well-known OAuth protected resource metadata.`,
    );
  }
  return OAuthProtectedResourceMetadataSchema.parse(await response.json());
}

/**
 * Helper function to handle fetch with CORS retry logic
 */
async function fetchWithCorsRetry(
  url: URL,
  headers?: Record<string, string>,
): Promise<Response | undefined> {
  try {
    return await fetch(url, { headers });
  } catch (error) {
    if (error instanceof TypeError) {
      if (headers) {
        // CORS errors come back as TypeError, retry without headers
        return fetchWithCorsRetry(url);
      } else {
        // We're getting CORS errors on retry too, return undefined
        return undefined;
      }
    }
    throw error;
  }
}

/**
 * Constructs the well-known path for OAuth metadata discovery
 */
function buildWellKnownPath(pathname: string): string {
  let wellKnownPath = `/.well-known/oauth-authorization-server${pathname}`;
  if (pathname.endsWith("/")) {
    // Strip trailing slash from pathname to avoid double slashes
    wellKnownPath = wellKnownPath.slice(0, -1);
  }
  return wellKnownPath;
}

/**
 * Tries to discover OAuth metadata at a specific URL
 */
async function tryMetadataDiscovery(
  url: URL,
  protocolVersion: string,
): Promise<Response | undefined> {
  const headers = {
    "MCP-Protocol-Version": protocolVersion,
  };
  return await fetchWithCorsRetry(url, headers);
}

/**
 * Determines if fallback to root discovery should be attempted
 */
function shouldAttemptFallback(
  response: Response | undefined,
  pathname: string,
): boolean {
  return !response || response.status === 404 && pathname !== "/";
}

/**
 * Looks up RFC 8414 OAuth 2.0 Authorization Server Metadata.
 *
 * If the server returns a 404 for the well-known endpoint, this function will
 * return `undefined`. Any other errors will be thrown as exceptions.
 */
export async function discoverOAuthMetadata(
  authorizationServerUrl: string | URL,
  opts?: { protocolVersion?: string },
): Promise<OAuthMetadata | undefined> {
  const issuer = new URL(authorizationServerUrl);
  const protocolVersion = opts?.protocolVersion ?? LATEST_PROTOCOL_VERSION;

  // Try path-aware discovery first (RFC 8414 compliant)
  const wellKnownPath = buildWellKnownPath(issuer.pathname);
  const pathAwareUrl = new URL(wellKnownPath, issuer);
  let response = await tryMetadataDiscovery(pathAwareUrl, protocolVersion);

  // If path-aware discovery fails with 404, try fallback to root discovery
  if (shouldAttemptFallback(response, issuer.pathname)) {
    const rootUrl = new URL("/.well-known/oauth-authorization-server", issuer);
    response = await tryMetadataDiscovery(rootUrl, protocolVersion);
  }
  if (!response || response.status === 404) {
    return undefined;
  }

  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status} trying to load well-known OAuth metadata`,
    );
  }

  return OAuthMetadataSchema.parse(await response.json());
}

/**
 * Begins the authorization flow with the given server, by generating a PKCE challenge and constructing the authorization URL.
 */
export async function startAuthorization(
  authorizationServerUrl: string | URL,
  {
    metadata,
    clientInformation,
    redirectUrl,
    scope,
    state,
    resource,
  }: {
    metadata?: OAuthMetadata;
    clientInformation: OAuthClientInformation;
    redirectUrl: string | URL;
    scope?: string;
    state?: string;
    resource?: URL;
  },
): Promise<{ authorizationUrl: URL; codeVerifier: string }> {
  const responseType = "code";
  const codeChallengeMethod = "S256";

  let authorizationUrl: URL;
  if (metadata) {
    authorizationUrl = new URL(metadata.authorization_endpoint);

    if (!metadata.response_types_supported.includes(responseType)) {
      throw new Error(
        `Incompatible auth server: does not support response type ${responseType}`,
      );
    }

    if (
      !metadata.code_challenge_methods_supported ||
      !metadata.code_challenge_methods_supported.includes(codeChallengeMethod)
    ) {
      throw new Error(
        `Incompatible auth server: does not support code challenge method ${codeChallengeMethod}`,
      );
    }
  } else {
    authorizationUrl = new URL("/authorize", authorizationServerUrl);
  }

  // Generate PKCE challenge
  const challenge = await pkceChallenge();
  const codeVerifier = challenge.code_verifier;
  const codeChallenge = challenge.code_challenge;

  authorizationUrl.searchParams.set("response_type", responseType);
  authorizationUrl.searchParams.set("client_id", clientInformation.client_id);
  authorizationUrl.searchParams.set("code_challenge", codeChallenge);
  authorizationUrl.searchParams.set(
    "code_challenge_method",
    codeChallengeMethod,
  );
  authorizationUrl.searchParams.set("redirect_uri", String(redirectUrl));

  if (state) {
    authorizationUrl.searchParams.set("state", state);
  }

  if (scope) {
    authorizationUrl.searchParams.set("scope", scope);
  }

  if (resource) {
    authorizationUrl.searchParams.set("resource", resource.href);
  }

  return { authorizationUrl, codeVerifier };
}

/**
 * Exchanges an authorization code for an access token with the given server.
 */
export async function exchangeAuthorization(
  authorizationServerUrl: string | URL,
  {
    metadata,
    clientInformation,
    authorizationCode,
    codeVerifier,
    redirectUri,
    resource,
  }: {
    metadata?: OAuthMetadata;
    clientInformation: OAuthClientInformation;
    authorizationCode: string;
    codeVerifier: string;
    redirectUri: string | URL;
    resource?: URL;
  },
): Promise<OAuthTokens> {
  const grantType = "authorization_code";

  let tokenUrl: URL;
  if (metadata) {
    tokenUrl = new URL(metadata.token_endpoint);

    if (
      metadata.grant_types_supported &&
      !metadata.grant_types_supported.includes(grantType)
    ) {
      throw new Error(
        `Incompatible auth server: does not support grant type ${grantType}`,
      );
    }
  } else {
    tokenUrl = new URL("/token", authorizationServerUrl);
  }

  // Exchange code for tokens
  const params = new URLSearchParams({
    grant_type: grantType,
    client_id: clientInformation.client_id,
    code: authorizationCode,
    code_verifier: codeVerifier,
    redirect_uri: String(redirectUri),
  });

  if (clientInformation.client_secret) {
    params.set("client_secret", clientInformation.client_secret);
  }

  if (resource) {
    params.set("resource", resource.href);
  }

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params,
  });

  if (!response.ok) {
    throw new Error(`Token exchange failed: HTTP ${response.status}`);
  }

  return OAuthTokensSchema.parse(await response.json());
}

/**
 * Exchange a refresh token for an updated access token.
 */
export async function refreshAuthorization(
  authorizationServerUrl: string | URL,
  {
    metadata,
    clientInformation,
    refreshToken,
    resource,
  }: {
    metadata?: OAuthMetadata;
    clientInformation: OAuthClientInformation;
    refreshToken: string;
    resource?: URL;
  },
): Promise<OAuthTokens> {
  const grantType = "refresh_token";

  let tokenUrl: URL;
  if (metadata) {
    tokenUrl = new URL(metadata.token_endpoint);

    if (
      metadata.grant_types_supported &&
      !metadata.grant_types_supported.includes(grantType)
    ) {
      throw new Error(
        `Incompatible auth server: does not support grant type ${grantType}`,
      );
    }
  } else {
    tokenUrl = new URL("/token", authorizationServerUrl);
  }

  // Exchange refresh token
  const params = new URLSearchParams({
    grant_type: grantType,
    client_id: clientInformation.client_id,
    refresh_token: refreshToken,
  });

  if (clientInformation.client_secret) {
    params.set("client_secret", clientInformation.client_secret);
  }

  if (resource) {
    params.set("resource", resource.href);
  }

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params,
  });
  if (!response.ok) {
    throw new Error(`Token refresh failed: HTTP ${response.status}`);
  }

  return OAuthTokensSchema.parse({
    refresh_token: refreshToken,
    ...(await response.json()),
  });
}

/**
 * Performs OAuth 2.0 Dynamic Client Registration according to RFC 7591.
 */
export async function registerClient(
  authorizationServerUrl: string | URL,
  {
    metadata,
    clientMetadata,
  }: {
    metadata?: OAuthMetadata;
    clientMetadata: OAuthClientMetadata;
  },
): Promise<OAuthClientInformationFull> {
  let registrationUrl: URL;

  if (metadata) {
    if (!metadata.registration_endpoint) {
      throw new Error(
        "Incompatible auth server: does not support dynamic client registration",
      );
    }

    registrationUrl = new URL(metadata.registration_endpoint);
  } else {
    registrationUrl = new URL("/register", authorizationServerUrl);
  }

  const response = await fetch(registrationUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(clientMetadata),
  });

  if (!response.ok) {
    throw new Error(
      `Dynamic client registration failed: HTTP ${response.status}`,
    );
  }

  return OAuthClientInformationFullSchema.parse(await response.json());
}
