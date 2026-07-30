export class Notice {
  constructor(_message: string, _timeout?: number) {}
}

export async function requestUrl(): Promise<never> {
  throw new Error("requestUrl is not available in unit tests");
}
