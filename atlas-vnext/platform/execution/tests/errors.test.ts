import { describe, expect, it } from 'vitest';
import {
  ProviderHttpError,
  classifyProviderFailure,
  httpFailure,
  isAuthenticationFailureBody,
} from '@atlas-vnext/execution';

const XAI_INVALID_KEY_BODY =
  '{"code":"invalid-argument","error":"Incorrect API key provided. You can obtain an API key from https://console.x.ai."}';

describe('execution failure classification', () => {
  it('classifies xAI-shaped HTTP 400 incorrect API key as authentication_failure', () => {
    const failure = httpFailure('xai', 400, XAI_INVALID_KEY_BODY);
    expect(failure.code).toBe('authentication_failure');
    expect(failure.retryable).toBe(false);
    expect(isAuthenticationFailureBody(XAI_INVALID_KEY_BODY)).toBe(true);
    expect(classifyProviderFailure(new ProviderHttpError(failure)).code).toBe('authentication_failure');
  });

  it('classifies OpenAI-shaped invalid_api_key bodies as authentication_failure', () => {
    expect(
      httpFailure(
        'openai',
        400,
        '{"error":{"message":"Incorrect API key provided","code":"invalid_api_key"}}',
      ).code,
    ).toBe('authentication_failure');
    expect(httpFailure('openai', 401, 'invalid api key').code).toBe('authentication_failure');
    expect(httpFailure('anthropic', 403, 'unauthorized').code).toBe('authentication_failure');
  });

  it('does not treat generic HTTP 400 or invalid-argument as authentication failure', () => {
    expect(httpFailure('xai', 400, '{"code":"invalid-argument","error":"messages is required"}').code).toBe(
      'provider_error',
    );
    expect(httpFailure('xai', 400, '{"code":"invalid-argument","error":"max tokens too high"}').code).toBe(
      'provider_error',
    );
    expect(httpFailure('openai', 400, 'bad request').code).toBe('provider_error');
    expect(httpFailure('xai', 400, 'Your credit balance is too low').code).toBe('provider_error');
    expect(isAuthenticationFailureBody('{"code":"invalid-argument","error":"messages is required"}')).toBe(false);
    expect(classifyProviderFailure(new ProviderHttpError(httpFailure('openai', 400, 'bad request'))).code).toBe(
      'provider_error',
    );
  });

  it('keeps context overflow and unsupported 400s on their existing codes', () => {
    expect(httpFailure('openai', 400, 'maximum context length exceeded').code).toBe('context_overflow');
    expect(httpFailure('openai', 400, 'unsupported model').code).toBe('unsupported');
  });

  it('classifies missing-credential Errors as authentication_failure and generic 400 Errors as invalid_request', () => {
    expect(classifyProviderFailure(new Error('xai is unavailable: missing credentials.')).code).toBe(
      'authentication_failure',
    );
    expect(classifyProviderFailure(new Error('Incorrect API key provided.')).code).toBe('authentication_failure');
    expect(classifyProviderFailure(new Error('HTTP 400 bad request')).code).toBe('invalid_request');
  });
});
