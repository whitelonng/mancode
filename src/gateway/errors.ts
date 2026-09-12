export class GatewayError extends Error {
  constructor(
    public readonly code: string,
    public readonly status = 400,
  ) {
    super(code);
  }
}

export function gatewayErrorCode(error: unknown): string {
  return error instanceof GatewayError ? error.code : 'MANCODE_GATEWAY_FAILED';
}
