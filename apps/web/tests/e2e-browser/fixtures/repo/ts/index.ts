export interface Greeting {
  message: string;
  count: number;
}

export const greeting: Greeting = { message: "hi", count: 1 };

export function describe(value: Greeting): string {
  return `${value.message} x${value.count}`;
}
