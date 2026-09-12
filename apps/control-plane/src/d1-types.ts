export type D1Value = string | number | null | ArrayBuffer | ArrayBufferView;

export interface D1Result<T = unknown> {
  success: boolean;
  results?: T[];
  meta?: {
    changes?: number;
    last_row_id?: number;
    [key: string]: unknown;
  };
  error?: string;
}

export interface D1PreparedStatement {
  bind(...values: D1Value[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(columnName?: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
}
