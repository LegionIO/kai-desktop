export type BrowserDataClearOperation = {
  label: string;
  run: () => void | Promise<void>;
};

function operationError(label: string, error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error);
  return new Error(`${label}: ${detail}`, { cause: error });
}

/**
 * Data categories are independent from a privacy perspective: a locked cache
 * must not prevent the password vault or Kai metadata from being erased. Run
 * every category, then report the complete failure set to the caller.
 */
export async function runBrowserDataClearOperations(
  description: string,
  operations: BrowserDataClearOperation[],
): Promise<void> {
  const failures: Error[] = [];
  for (const operation of operations) {
    try {
      await operation.run();
    } catch (error) {
      failures.push(operationError(operation.label, error));
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `${description} failed: ${failures.map((failure) => failure.message).join('; ')}`,
    );
  }
}
