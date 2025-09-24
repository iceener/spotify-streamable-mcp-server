export class CancellationError extends Error {
  constructor(message = 'Operation was cancelled') {
    super(message);
    this.name = 'CancellationError';
  }
}

export class CancellationToken {
  private isCancelledInternal = false;
  private readonly listeners: Array<() => void> = [];

  get isCancelled(): boolean {
    return this.isCancelledInternal;
  }

  cancel(): void {
    if (this.isCancelledInternal) {
      return;
    }
    this.isCancelledInternal = true;
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {}
    }
    this.listeners.length = 0;
  }

  onCancelled(listener: () => void): void {
    if (this.isCancelledInternal) {
      listener();
      return;
    }
    this.listeners.push(listener);
  }

  throwIfCancelled(): void {
    if (this.isCancelledInternal) {
      throw new CancellationError();
    }
  }
}

export function createCancellationToken(): CancellationToken {
  return new CancellationToken();
}

export async function withCancellation<T>(
  operation: (token: CancellationToken) => Promise<T>,
  token: CancellationToken,
): Promise<T> {
  token.throwIfCancelled();

  return new Promise<T>((resolve, reject) => {
    let completed = false;

    token.onCancelled(() => {
      if (!completed) {
        completed = true;
        reject(new CancellationError());
      }
    });

    operation(token)
      .then((result) => {
        if (!completed) {
          completed = true;
          resolve(result);
        }
      })
      .catch((error) => {
        if (!completed) {
          completed = true;
          reject(error);
        }
      });
  });
}
