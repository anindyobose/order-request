export const RDS_CA_FILE: string;

export function createDatabaseUrl(
  environment?: Record<string, string | undefined>,
): string;

export function connectWithRetry(
  connect: () => Promise<unknown>,
  options?: {
    maxWaitMs?: number;
    onRetry?: (attempt: number, delayMs: number) => void;
  },
): Promise<void>;
