export enum RpcErrorCode {
  ParseError = -32700,
  InvalidRequest = -32600,
  MethodNotFound = -32601,
  InvalidParams = -32602,
  InternalError = -32603,
  AppErrorBase = -32000,
}

export const rpcError = (code: number, message: string, data?: unknown) => ({
  jsonrpc: '2.0' as const,
  error: { code, message, data },
  id: null,
});

export const toolExecError = (message: string) => ({
  content: [{ type: 'text' as const, text: message }],
  isError: true,
});

export const invalidParamsError = (message: string, data?: unknown) =>
  rpcError(RpcErrorCode.InvalidParams, message, data);

export const internalError = (message: string, data?: unknown) =>
  rpcError(RpcErrorCode.InternalError, message, data);

export const appError = (message: string, data?: unknown) =>
  rpcError(RpcErrorCode.AppErrorBase, message, data);
