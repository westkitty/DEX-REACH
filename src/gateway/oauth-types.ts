import { OAuthError, OAuthErrorCode } from '@modelcontextprotocol/server';

export type AuthorizationParams = {
  state?: string;
  scopes?: string[];
  codeChallenge: string;
  redirectUri: string;
  resource?: URL;
  issuer?: string;
};

export class InvalidRequestError extends OAuthError {
  constructor(message: string) { super(OAuthErrorCode.InvalidRequest, message); }
}

export class InvalidClientError extends OAuthError {
  constructor(message: string) { super(OAuthErrorCode.InvalidClient, message); }
}

export class InvalidGrantError extends OAuthError {
  constructor(message: string) { super(OAuthErrorCode.InvalidGrant, message); }
}

export class InvalidScopeError extends OAuthError {
  constructor(message: string) { super(OAuthErrorCode.InvalidScope, message); }
}

export class UnsupportedGrantTypeError extends OAuthError {
  constructor(message: string) { super(OAuthErrorCode.UnsupportedGrantType, message); }
}
