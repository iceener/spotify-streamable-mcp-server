export class CancellationError extends Error {
  constructor(message = 'Operation was cancelled') {
    super(message);
    this.name = 'CancellationError';
  }
}

export class CancellationToken {
  private _isCancelled = false;
  private _listeners: (() => void)[] = [];

  get isCancelled(): boolean {
    return this._isCancelled;
  }

  cancel(): void {
    if (this._isCancelled) return;

    this._isCancelled = true;
    this._listeners.forEach((listener) => {
      try {
        listener();
      } catch (error) {
        console.error('Error in cancellation listener:', error);
      }
    });
    this._listeners.length = 0;
  }

  onCancelled(listener: () => void): void {
    if (this._isCancelled) {
      listener();
      return;
    }
    this._listeners.push(listener);
  }

  throwIfCancelled(): void {
    if (this._isCancelled) {
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

  return new Promise((resolve, reject) => {
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
